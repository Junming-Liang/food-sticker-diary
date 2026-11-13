"""Deliver opted-in buddy notifications without blocking meal uploads."""
import http.client
import json
import logging
import os
import socket
import ssl
import time
from urllib.parse import urlsplit

import requests
from py_vapid import VapidException
from pywebpush import WebPushException, webpush

import app as application
import notifications


class FcmTunnelConnection(http.client.HTTPSConnection):
    """Use the optional SSH tunnel while validating the real FCM TLS identity."""
    def __init__(self, port, timeout):
        super().__init__('fcm.googleapis.com', timeout=timeout, context=ssl.create_default_context())
        self.tunnel_port = port

    def connect(self):
        sock = socket.create_connection(('127.0.0.1', self.tunnel_port), self.timeout)
        try: self.sock = self._context.wrap_socket(sock, server_hostname='fcm.googleapis.com')
        except Exception:
            sock.close()
            raise


class PushSession:
    def __init__(self):
        self.direct = requests.Session()
        self.direct.trust_env = False
        port = os.environ.get('FOOD_FCM_TUNNEL_PORT', '')
        self.port = int(port) if port else None
        if self.port is not None and not 1 <= self.port <= 65535:
            raise ValueError('Invalid push tunnel port')

    def post(self, url, data=None, headers=None, timeout=10):
        if not notifications.valid_endpoint(url): raise ValueError('Invalid push endpoint')
        parsed = urlsplit(url)
        if parsed.hostname != 'fcm.googleapis.com' or not self.port:
            return self.direct.post(url, data=data, headers=headers, timeout=timeout, allow_redirects=False)
        connection = FcmTunnelConnection(self.port, timeout)
        try:
            path = parsed.path + ('?' + parsed.query if parsed.query else '')
            connection.request('POST', path, body=data, headers=dict(headers or {}))
            incoming = connection.getresponse()
            response = requests.Response()
            response.status_code = incoming.status
            response.reason = incoming.reason
            response.headers = requests.structures.CaseInsensitiveDict(incoming.getheaders())
            response._content = incoming.read(65536)
            return response
        finally:
            connection.close()


def deliver_one(session, now=None):
    """Process one queued message; only the dedicated worker should call this in production."""
    now = int(time.time()) if now is None else int(now)
    with application.app.app_context():
        database = application.db()
        row = database.execute('''SELECT q.id AS job_id,q.created,q.attempts,q.meal_id,
                   m.day,s.id AS subscription_id,s.subscription,
                   EXISTS(SELECT 1 FROM buddy_members mine JOIN buddy_members peer
                          ON peer.pair_id=mine.pair_id AND peer.user_id<>mine.user_id
                          WHERE mine.user_id=m.user_id AND peer.user_id=s.user_id AND mine.sharing=1) AS permitted
            FROM push_outbox q JOIN meals m ON m.id=q.meal_id
            JOIN push_subscriptions s ON s.id=q.subscription_id
            WHERE q.next_attempt<=? ORDER BY q.id LIMIT 1''',(now,)).fetchone()
        if not row: return False
        if not row['permitted'] or now-row['created']>=86400:
            database.execute('DELETE FROM push_outbox WHERE id=?',(row['job_id'],));database.commit()
            return True
        try:
            subscription=notifications.validate_subscription(json.loads(row['subscription']))
            data=json.dumps({'day':row['day'],'id':row['meal_id']},separators=(',',':'))
            webpush(subscription_info=subscription,data=data,
                    vapid_private_key=str(notifications.vapid_key_path(application.DATA)),
                    vapid_claims={'sub':os.environ.get('FOOD_PUSH_SUBJECT','https://github.com')},
                    ttl=max(1,86400-(now-row['created'])),timeout=10,requests_session=session)
        except WebPushException as exc:
            status=exc.response.status_code if exc.response is not None else None
            if status in (404,410):
                database.execute('DELETE FROM push_subscriptions WHERE id=?',(row['subscription_id'],))
            elif status is not None and 400<=status<500 and status!=429:
                database.execute('DELETE FROM push_outbox WHERE id=?',(row['job_id'],))
                logging.warning('Push service rejected a notification: HTTP %s',status)
            else:
                retry(database,row,now)
        except (OSError, ValueError, VapidException, http.client.HTTPException, requests.RequestException) as exc:
            logging.warning('Push delivery temporarily failed: %s',type(exc).__name__)
            retry(database,row,now)
        else:
            database.execute('DELETE FROM push_outbox WHERE id=?',(row['job_id'],))
        database.commit()
        return True


def retry(database, row, now):
    attempts=row['attempts']+1
    delay=min(3600,30*(2**min(attempts-1,7)))
    database.execute('UPDATE push_outbox SET attempts=?,next_attempt=? WHERE id=?',
                     (attempts,now+delay,row['job_id']))


def main():
    logging.basicConfig(level=logging.INFO,format='%(levelname)s: %(message)s')
    session=PushSession()
    while True:
        try: processed=deliver_one(session)
        except Exception as exc:
            logging.error('Push worker failed: %s',type(exc).__name__)
            processed=False
        if not processed: time.sleep(5)


if __name__=='__main__': main()
