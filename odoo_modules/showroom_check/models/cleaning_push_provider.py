"""Sending a push notification through Firebase Cloud Messaging.

Plain REST with `requests`, exactly like cleaning_ai_provider next door, and for
the same reason: no new Python dependency and no vendor SDK to keep in step with
an Odoo upgrade. The OAuth2 assertion is signed with `cryptography`, which Odoo
already requires - so this whole file adds nothing to the install.

Deliberately FCM's own HTTP v1 API rather than Expo's push service. Expo's would
be a simpler POST, but it needs an EAS account and project id this app does not
have, and it puts a second company between the server and the phone for a
feature that only ships to Android. One vendor, one credential.

Nothing here touches the ORM. The model layer decides who to notify and what to
say; this file knows only how to get a token and post a message.
"""
import base64
import json
import logging
import time

import requests

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

_logger = logging.getLogger(__name__)

OAUTH_TOKEN_URI = 'https://oauth2.googleapis.com/token'
FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects/%s/messages:send'

# The narrow scope, not cloud-platform. This key should be able to send a
# message and do nothing else whatever: it lives in a database that a fair
# number of people can reach, and the blast radius if it leaks is worth
# thinking about once, here, rather than never.
SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

JWT_LIFETIME = 3600
# Re-fetch a little before Google would expire it. The token is good for an
# hour; asking again at 55 minutes means a round is never notified with a
# credential that went stale between minting it and using it.
TOKEN_CACHE_SECONDS = 3300

# Ten seconds, not the AI config's 120. This runs inside the upload request,
# which is already measured against odoo.conf's limit_time_real - see the note
# at the top of cleaning_config.py. A notification that is slow to send must
# never be the reason somebody's round times out.
DEFAULT_TIMEOUT = 10

# The channel the app creates with setNotificationChannelAsync. The two have to
# agree or Android files the message under a channel that does not exist, and
# on Android 8+ that means it is never shown at all.
CHANNEL_ID = 'low-match'

# client_email -> (access_token, expires_at). Per worker process, not shared,
# which is fine: the worst case is each worker fetching its own token once an
# hour rather than all of them sharing one.
_TOKEN_CACHE = {}

# The errorCodes that mean "this phone is gone, stop writing to it". Anything
# else is a problem with the message or the network and the token should be
# kept - deleting a good token because Google was briefly unreachable would
# silently unsubscribe a manager.
DEAD_TOKEN_CODES = {'UNREGISTERED', 'INVALID_ARGUMENT'}


class PushError(Exception):
    """Anything that stopped a notification going out.

    Carries a sentence for whoever pressed Test Push, not a stack trace.
    """


def _b64url(raw):
    """Base64url with the padding stripped, which is what JWT wants."""
    return base64.urlsafe_b64encode(raw).rstrip(b'=')


def _signed_assertion(key_dict):
    """The JWT that proves we hold the service account's private key.

    Hand-rolled rather than pulled from google-auth, which is not installed on
    a stock Odoo and would be a new dependency on every server this module runs
    on. It is three base64 segments and one RS256 signature; the library would
    be doing exactly this.
    """
    client_email = (key_dict.get('client_email') or '').strip()
    private_key = key_dict.get('private_key') or ''
    if not client_email or not private_key:
        raise PushError(
            "The service account file is missing client_email or private_key. "
            "Make sure the whole JSON file was pasted, not just part of it.")

    issued = int(time.time())
    header = {'alg': 'RS256', 'typ': 'JWT'}
    claims = {
        'iss': client_email,
        'scope': SCOPE,
        'aud': key_dict.get('token_uri') or OAUTH_TOKEN_URI,
        'iat': issued,
        'exp': issued + JWT_LIFETIME,
    }
    segments = [
        _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8')),
        _b64url(json.dumps(claims, separators=(',', ':')).encode('utf-8')),
    ]
    signing_input = b'.'.join(segments)

    try:
        # The private_key in a service account file carries literal backslash-n
        # sequences when it has been through a JSON round trip by hand. Loading
        # fails cryptically on those, so they are normalised here rather than
        # leaving somebody to work out why a key that "looks right" is refused.
        pem = private_key.replace('\\n', '\n').encode('utf-8')
        key = serialization.load_pem_private_key(pem, password=None)
        signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    except PushError:
        raise
    except Exception as exc:  # noqa: BLE001 - any key problem reads the same
        raise PushError(
            "The private key in the service account file could not be read: "
            "%s" % exc)

    segments.append(_b64url(signature))
    return b'.'.join(segments).decode('ascii')


def access_token(key_dict, timeout=DEFAULT_TIMEOUT):
    """A bearer token for FCM, minted from the service account key.

    Cached for just under its lifetime, so a busy morning of rounds costs one
    round trip to Google rather than one per notification.
    """
    client_email = (key_dict.get('client_email') or '').strip()
    cached = _TOKEN_CACHE.get(client_email)
    if cached and cached[1] > time.time():
        return cached[0]

    assertion = _signed_assertion(key_dict)
    try:
        response = requests.post(
            key_dict.get('token_uri') or OAUTH_TOKEN_URI,
            data={
                'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion': assertion,
            },
            timeout=timeout,
        )
    except requests.exceptions.Timeout:
        raise PushError(
            "Google did not answer in time when asked for an access token. "
            "Check the server's internet connection.")
    except requests.exceptions.RequestException as exc:
        raise PushError("Could not reach Google to sign in: %s" % exc)

    if response.status_code != 200:
        # Google says why, and it is usually something specific and fixable -
        # a clock that is wrong, or a key that has been revoked.
        raise PushError(
            "Google refused the service account (HTTP %s): %s"
            % (response.status_code, (response.text or '')[:300]))

    try:
        token = response.json().get('access_token')
    except ValueError:
        raise PushError("Google's reply to the sign-in could not be read.")
    if not token:
        raise PushError("Google signed in but returned no access token.")

    _TOKEN_CACHE[client_email] = (token, time.time() + TOKEN_CACHE_SECONDS)
    return token


def forget_cached_token(key_dict):
    """Drop a cached token, so the next send mints a fresh one.

    Called when the credentials are edited: without it, changing the service
    account and pressing Test Push would keep using the old token for up to an
    hour and report a success that says nothing about the new key.
    """
    _TOKEN_CACHE.pop((key_dict.get('client_email') or '').strip(), None)


def _dead_token(body):
    """Does this error body mean the phone is gone for good?"""
    error = (body or {}).get('error') or {}
    for detail in error.get('details') or []:
        if detail.get('errorCode') in DEAD_TOKEN_CODES:
            return True
    # A token that was never valid, or has been wiped, comes back as NOT_FOUND
    # without always carrying the FcmError detail above.
    return error.get('status') == 'NOT_FOUND'


def build_message(device_token, title, body, data=None):
    """The FCM v1 message body.

    Carries FCM's own `notification` block, NOT the data-only shape Expo's
    documentation shows. That choice is the whole reason a manager sees this in
    the notification shade at all: Android itself draws a message that has a
    `notification` block, so it appears whether the app is backgrounded or has
    been swiped away entirely. A data-only message is handed to the app instead,
    which means nothing is drawn when the app is not running - which is exactly
    when somebody most needs telling.

    `data` therefore carries only what the tap needs. Putting the title and body
    in BOTH places is the obvious-looking mistake and produces two notifications
    for one round: one drawn by Android, one drawn by expo-notifications.

    android.priority high, because this is worth waking a screen for; without it
    a dozing phone can sit on the message until the next time it happens to be
    awake, and a round flagged at 09:05 is read at lunchtime.
    """
    return {
        'message': {
            'token': device_token,
            'notification': {'title': title, 'body': body},
            'android': {
                'priority': 'high',
                'notification': {
                    'channel_id': CHANNEL_ID,
                    'notification_priority': 'PRIORITY_MAX',
                    # Collapsing on the round means a phone that was off all
                    # morning shows one line per round rather than one per
                    # delivery attempt.
                    'tag': str((data or {}).get('recordingId') or ''),
                },
            },
            'data': {
                # Every value has to be a string: FCM rejects a data payload
                # with a number in it, and the failure is a flat 400 that says
                # nothing about which key was at fault.
                key: str(value) for key, value in (data or {}).items()
            },
        }
    }


def send(project_id, token, device_token, title, body, data=None,
         timeout=DEFAULT_TIMEOUT):
    """Post one message to one phone.

    Returns {'ok': bool, 'dead': bool, 'error': str|None}. Never raises: one
    unreachable phone must not stop the other managers being told, and none of
    this may take a round down with it.
    """
    try:
        response = requests.post(
            FCM_ENDPOINT % project_id,
            json=build_message(device_token, title, body, data),
            timeout=timeout,
            headers={'Authorization': 'Bearer %s' % token},
        )
    except requests.exceptions.RequestException as exc:
        return {'ok': False, 'dead': False, 'error': str(exc)}

    if response.status_code == 200:
        return {'ok': True, 'dead': False, 'error': None}

    try:
        body_json = response.json()
    except ValueError:
        body_json = {}
    return {
        'ok': False,
        'dead': _dead_token(body_json),
        'error': '%s %s' % (response.status_code, (response.text or '')[:300]),
    }
