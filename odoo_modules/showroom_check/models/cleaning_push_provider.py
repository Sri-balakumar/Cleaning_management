"""Sending a push notification through Expo's push service.

Plain REST with `requests`, exactly like cleaning_ai_provider next door, and for
the same reason: no new Python dependency and no vendor SDK to keep in step with
an Odoo upgrade.

Expo is a RELAY, not a replacement for Firebase. The Firebase service account
key is uploaded to EAS rather than kept here, and Expo authenticates to FCM as
you and delivers through it. The last mile is FCM either way - the same
google-services.json, the same Firebase project. What changes is only who holds
the credential and makes the call. That is why the app still needs
google-services.json even though nothing in this file mentions Firebase.

Deliberately the same shape as kra_kpi_module's kpi_notify, so this
organisation has one notification pattern rather than two. The three things
that file learned the hard way are carried over rather than rediscovered:
sends are grouped by EAS project, a rejection is named rather than swallowed,
and the count reported is what Expo ACCEPTED rather than what was attempted.

Nothing here touches the ORM. The model layer decides who to notify and what to
say; this file knows only how to post a batch and read the answer.
"""
import json
import logging

import requests

_logger = logging.getLogger(__name__)

EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

# Ten seconds, not the AI config's 120. This runs inside the upload request,
# which is already measured against odoo.conf's limit_time_real - see the note
# at the top of cleaning_config.py. A notification that is slow to send must
# never be the reason somebody's round times out.
DEFAULT_TIMEOUT = 10

# The channel the app creates with setNotificationChannelAsync. The two have to
# agree or Android files the message under a channel that does not exist, and
# on Android 8+ that means it is never shown at all.
CHANNEL_ID = 'low-match'

# Expo takes at most 100 messages in one request.
MAX_BATCH = 100

# Android collapses a banner far shorter than this, and the rest is dead weight
# in the shade. 160 is roughly what fits before a phone stops showing it.
MAX_BODY_CHARS = 160

# The one ticket error that means "this phone is gone, retire it". Anything
# else is about the message or the credentials, and retiring a good token
# because Expo was briefly unhappy would silently unsubscribe a manager.
RETIRE_ERRORS = {'DeviceNotRegistered'}

# Errors that mean the SETUP is wrong, not the phone. Named individually
# because the alternative is what kra_kpi_module had to learn the hard way: a
# push Expo rejected outright looked identical in the log to one that was
# delivered, so the most common real failure was invisible for weeks.
#
# Neither is fixable from Odoo - both live in the EAS account - so the least
# this can do is say which one it is.
CONFIG_ERRORS = {
    'MismatchSenderId': (
        "the FCM credentials on EAS do not match the google-services.json "
        "baked into the build. Re-upload the service account key with "
        "`eas credentials`, or rebuild the app against the right Firebase "
        "project."),
    'InvalidCredentials': (
        "the Firebase service account key on EAS is missing or expired. "
        "Upload it again with `eas credentials`."),
}


class PushError(Exception):
    """Anything that stopped a notification going out.

    Carries a sentence for whoever pressed Test Push, not a stack trace.
    """


def shorten(text, limit=MAX_BODY_CHARS):
    """Trim a notification body to something a banner can actually show."""
    text = (text or '').strip()
    if len(text) <= limit:
        return text
    return text[:limit - 3].rstrip() + '...'


def build_message(token, title, body, data=None):
    """One Expo push message.

    `priority: high` because this is worth waking a screen for; without it a
    dozing phone can sit on the message until it next happens to be awake, and
    a round flagged at 09:05 gets read at lunchtime.

    channelId rather than a notification block: on the Expo path it is Expo
    that talks to FCM, and this is how it is told which Android channel to file
    the message under.
    """
    return {
        'to': token,
        'title': title,
        'body': shorten(body),
        'data': data or {},
        'channelId': CHANNEL_ID,
        'priority': 'high',
        'sound': 'default',
    }


def _post(messages, timeout):
    """POST one batch. Raises PushError; never returns a half-understood reply."""
    try:
        response = requests.post(
            EXPO_PUSH_URL,
            data=json.dumps(messages),
            headers={
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout=timeout,
        )
    except requests.exceptions.Timeout:
        raise PushError(
            "Expo did not answer in time. Check the server's internet "
            "connection.")
    except requests.exceptions.RequestException as exc:
        raise PushError("Could not reach Expo: %s" % exc)
    return response


def send_batch(messages, timeout=DEFAULT_TIMEOUT):
    """Send up to MAX_BATCH messages that share one EAS project.

    Returns {'sent': int, 'retire': [token, ...], 'config': str|None}.

    Every message in `messages` must come from the SAME EAS project. Expo
    rejects a request whose messages span two projects and delivers to nobody
    in it, so one stale token from an older projectId would otherwise take
    every other manager's notification down with it. Grouping is the caller's
    job - see cleaning.push.device._grouped_by_project.
    """
    result = {'sent': 0, 'retire': [], 'config': None}
    if not messages:
        return result

    response = _post(messages, timeout)

    # A non-200 means Expo rejected the WHOLE batch - bad JSON, a rate limit,
    # an outage. Ignoring it is how a total failure comes to be logged as a
    # complete success, which is precisely the bug kpi_notify carries a
    # paragraph about.
    if response.status_code != 200:
        _logger.warning(
            "Showroom Check: Expo returned HTTP %s for %s message(s): %s",
            response.status_code, len(messages),
            (response.text or '')[:300])
        return result

    try:
        tickets = (response.json() or {}).get('data') or []
    except ValueError:
        _logger.warning("Showroom Check: Expo's reply could not be read.")
        return result

    # Tickets come back positionally, so a short list would silently mis-blame
    # the wrong token. Better to report nothing than the wrong thing.
    if len(tickets) != len(messages):
        _logger.warning(
            "Showroom Check: Expo returned %s ticket(s) for %s message(s); "
            "not attributing errors.", len(tickets), len(messages))
        return result

    other = {}
    for message, ticket in zip(messages, tickets):
        if ticket.get('status') == 'ok':
            result['sent'] += 1
            continue
        error = ((ticket.get('details') or {}).get('error')
                 or ticket.get('message') or 'unknown')
        if error in RETIRE_ERRORS:
            result['retire'].append(message['to'])
        elif error in CONFIG_ERRORS:
            result['config'] = '%s: %s' % (error, CONFIG_ERRORS[error])
        else:
            other[error] = other.get(error, 0) + 1

    if result['config']:
        _logger.warning("Showroom Check: push not delivered - %s",
                        result['config'])
    for error, count in other.items():
        _logger.warning(
            "Showroom Check: Expo refused %s message(s) with %s", count, error)
    return result
