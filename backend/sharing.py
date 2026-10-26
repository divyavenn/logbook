"""Signatures for shared entry links.

A link to an entry carries a signature, because entry IDs are consecutive: an
unsigned link would be a licence to count upwards and read the whole logbook.
The key is the password, as the session cookie's is, so changing the password
takes back every link that was ever shared.
"""
import hmac
import os

SHARE_LABEL = b'still-share-v1'
# Half of the digest. Sixty-four bits is far more than guessing can reach, and
# it keeps the link short enough to read out.
SIGNATURE_LENGTH = 16


def entry_signature(kind: str, item_id: int) -> str:
    key = os.environ.get('STILL_AUTH_PASSWORD', '').encode()
    message = b'%s:%s:%d' % (SHARE_LABEL, kind.encode(), item_id)
    return hmac.new(key, message, 'sha256').hexdigest()[:SIGNATURE_LENGTH]


def signature_valid(kind: str, item_id: int, supplied: str) -> bool:
    return hmac.compare_digest(supplied, entry_signature(kind, item_id))
