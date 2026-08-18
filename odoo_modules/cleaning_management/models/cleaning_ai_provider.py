"""Talking to the vision models.

Deliberately plain REST with `requests`, the way the rest of this codebase already
calls Groq/Anthropic/Gemini (see kra_kpi_module/controllers/kpi_reports_api.py and
whatsapp_email/models/voice_utils.py). No new Python dependency, and no vendor SDK
to keep in step with an Odoo upgrade.

Every adapter takes the same arguments and returns the same shape, so the model
layer never has to know which provider is configured.
"""
import base64
import json
import logging
import re

import requests

_logger = logging.getLogger(__name__)

GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com'

# Enough for a score, a summary and a handful of issues. Left configurable
# because a local Llama is often more verbose than a hosted model.
DEFAULT_MAX_OUTPUT_TOKENS = 1024
DEFAULT_TIMEOUT = 120


class AiError(Exception):
    """Anything that stopped us getting a usable answer.

    Carries a message meant for the person who pressed the button, not a stack
    trace - "the address is wrong" is actionable, "ConnectionError" is not.
    """


def extract_json(text):
    """Pull the JSON object out of a model's reply.

    Hosted models usually return clean JSON when asked. A local Llama very often
    does not: it wraps the object in ```json fences, or writes a sentence of
    preamble first, or both. Rather than failing on output that is perfectly
    usable, strip the wrapping and take the outermost {...}.

    Returns None when there is nothing parseable - the caller records the failure
    and keeps the raw text. A half-understood answer must never be presented as
    a result.
    """
    if not text:
        return None

    cleaned = text.strip()

    # ```json ... ``` or plain ``` ... ```
    fence = re.search(r'```(?:json)?\s*(.*?)```', cleaned, re.DOTALL)
    if fence:
        cleaned = fence.group(1).strip()

    try:
        return json.loads(cleaned)
    except (ValueError, TypeError):
        pass

    # Outermost braces, for a reply with prose around the object.
    start = cleaned.find('{')
    end = cleaned.rfind('}')
    if start != -1 and end > start:
        try:
            return json.loads(cleaned[start:end + 1])
        except (ValueError, TypeError):
            return None
    return None


def _post(url, payload, timeout, headers=None):
    """One place for the network call, so every provider fails the same way."""
    try:
        response = requests.post(
            url, json=payload, timeout=timeout, headers=headers or {})
    except requests.exceptions.ConnectTimeout:
        raise AiError(
            "The AI service did not answer in time. If this is a local model, "
            "check it is running; if it is Gemini, check the server's internet "
            "connection.")
    except requests.exceptions.ConnectionError:
        raise AiError(
            "Could not reach the AI service. Check the Base URL in the AI "
            "Review settings, and that the service is running.")
    except requests.exceptions.RequestException as exc:
        raise AiError("Could not contact the AI service: %s" % exc)

    if response.status_code == 401 or response.status_code == 403:
        raise AiError(
            "The AI service rejected the API key. Check the key in the AI "
            "Review settings.")
    if response.status_code == 404:
        raise AiError(
            "The AI service has no such model or address (404). Check the "
            "Model name and Base URL in the AI Review settings.")
    if response.status_code == 429:
        raise AiError(
            "The AI service is rate limiting us. Wait a moment and try again.")
    if response.status_code >= 400:
        # The body usually explains it far better than the status code does.
        detail = (response.text or '')[:400]
        raise AiError("The AI service returned an error (%s): %s"
                      % (response.status_code, detail))

    try:
        return response.json()
    except ValueError:
        raise AiError(
            "The AI service replied with something that was not JSON. This "
            "usually means the Base URL points at the wrong service.")


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------
def call_gemini(config, prompt, images, timeout):
    if not config['api_key']:
        raise AiError("Gemini needs an API key. Add one in the AI Review settings.")

    base = (config['base_url'] or GEMINI_ENDPOINT).rstrip('/')
    url = '%s/v1beta/models/%s:generateContent' % (base, config['model'])

    parts = [{'text': prompt}]
    for image in images:
        parts.append({
            'inline_data': {
                'mime_type': image['mimetype'],
                'data': base64.b64encode(image['data']).decode('ascii'),
            }
        })

    payload = {
        'contents': [{'role': 'user', 'parts': parts}],
        'generationConfig': {
            'maxOutputTokens': config['max_output_tokens'],
            # Near-zero, because this is a classification job. Creative variation
            # in a cleanliness verdict is a defect, not a feature.
            'temperature': 0.1,
            'responseMimeType': 'application/json',
        },
    }
    # Key in a header rather than the query string, so it does not end up in
    # request logs or proxy access logs.
    data = _post(url, payload, timeout,
                 headers={'x-goog-api-key': config['api_key']})

    try:
        return data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError, TypeError):
        blocked = (data.get('promptFeedback') or {}).get('blockReason')
        if blocked:
            raise AiError("Gemini declined to answer (%s)." % blocked)
        raise AiError("Gemini's reply had no content in it.")


# ---------------------------------------------------------------------------
# Ollama (local Llama and friends)
# ---------------------------------------------------------------------------
def call_ollama(config, prompt, images, timeout):
    if not config['base_url']:
        raise AiError(
            "Ollama needs a Base URL, for example http://localhost:11434. "
            "Add one in the AI Review settings.")

    url = '%s/api/chat' % config['base_url'].rstrip('/')
    payload = {
        'model': config['model'],
        'stream': False,
        'format': 'json',
        'options': {'temperature': 0.1},
        'messages': [{
            'role': 'user',
            'content': prompt,
            # Ollama takes bare base64 strings, with no data: prefix.
            'images': [
                base64.b64encode(image['data']).decode('ascii')
                for image in images
            ],
        }],
    }
    headers = {}
    if config['api_key']:
        # A bare Ollama needs no auth, but one behind a reverse proxy often does.
        headers['Authorization'] = 'Bearer %s' % config['api_key']

    data = _post(url, payload, timeout, headers=headers)
    content = (data.get('message') or {}).get('content')
    if not content:
        raise AiError("The local model returned an empty reply.")
    return content


# ---------------------------------------------------------------------------
# Anything speaking the OpenAI chat format (LM Studio, vLLM, ...)
# ---------------------------------------------------------------------------
def call_openai_compatible(config, prompt, images, timeout):
    if not config['base_url']:
        raise AiError(
            "This provider needs a Base URL. Add one in the AI Review settings.")

    url = '%s/chat/completions' % config['base_url'].rstrip('/')
    content = [{'type': 'text', 'text': prompt}]
    for image in images:
        content.append({
            'type': 'image_url',
            'image_url': {
                'url': 'data:%s;base64,%s' % (
                    image['mimetype'],
                    base64.b64encode(image['data']).decode('ascii')),
            },
        })

    payload = {
        'model': config['model'],
        'temperature': 0.1,
        'max_tokens': config['max_output_tokens'],
        'messages': [{'role': 'user', 'content': content}],
        'response_format': {'type': 'json_object'},
    }
    headers = {}
    if config['api_key']:
        headers['Authorization'] = 'Bearer %s' % config['api_key']

    data = _post(url, payload, timeout, headers=headers)
    try:
        return data['choices'][0]['message']['content']
    except (KeyError, IndexError, TypeError):
        raise AiError("The AI service's reply had no content in it.")


PROVIDERS = {
    'gemini': call_gemini,
    'ollama': call_ollama,
    'openai_compatible': call_openai_compatible,
}

DEFAULT_MODELS = {
    'gemini': 'gemini-2.5-flash',
    'ollama': 'llama3.2-vision',
    'openai_compatible': '',
}


def analyse(config, prompt, images):
    """Send the frames and prompt, and give back the raw reply plus parsed JSON.

    Returns ``(raw_text, parsed_or_None)``. Parsing is left to the caller to act
    on, so a reply that could not be understood is still stored for diagnosis
    rather than thrown away.
    """
    handler = PROVIDERS.get(config['provider'])
    if not handler:
        raise AiError("Unknown AI provider: %s" % config['provider'])
    if not config['model']:
        raise AiError("No model name is set in the AI Review settings.")

    timeout = config.get('timeout') or DEFAULT_TIMEOUT
    raw = handler(config, prompt, images, timeout)
    return raw, extract_json(raw)
