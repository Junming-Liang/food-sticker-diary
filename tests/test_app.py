import base64
import io
import os
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

tmp = tempfile.TemporaryDirectory(prefix='food-diary-test-')
os.environ['FOOD_DATA'] = tmp.name
os.environ['FOOD_COOKIE_SECURE'] = '0'
os.environ['FOOD_BASE'] = '/'
import app as application


def photo_data(mode='RGB'):
    out = io.BytesIO(); Image.new(mode, (20,20), (200,50,25,255) if mode=='RGBA' else (200,50,25)).save(out, 'PNG' if mode=='RGBA' else 'JPEG')
    return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode() if mode=='RGBA' else 'data:image/jpeg;base64,' + base64.b64encode(out.getvalue()).decode()


class DiaryTest(unittest.TestCase):
    def setUp(self):
        self.alice = application.app.test_client(); self.bob = application.app.test_client(); self.visitor = application.app.test_client()
        suffix = os.urandom(6).hex()
        self.alice.post('/api/auth/register',json={'username':'alice'+suffix,'password':'long-password'})
        self.bob.post('/api/auth/register',json={'username':'bob'+suffix,'password':'long-password'})

    def test_private_meal_share_and_revoke(self):
        meal = {'day':'2026-11-13','category':'lunch','name':'测试餐','grams':200,'calories':350,
                'carbs':30,'protein':20,'fat':10,'photo':photo_data(),'sticker':photo_data('RGBA')}
        result = self.alice.post('/api/meals',json=meal)
        self.assertEqual(result.status_code,201)
        mid = result.json['meal']['id']
        self.assertEqual(self.alice.get('/api/meals?day=2026-11-13').json['meals'][0]['name'],'测试餐')
        self.assertEqual(self.bob.get('/api/meals?day=2026-11-13').json['meals'],[])
        self.assertEqual(self.bob.get(f'/api/meals/{mid}/photo').status_code,404)
        self.assertEqual(self.bob.delete(f'/api/meals/{mid}').status_code,404)
        share = self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]
        token, sid = share['token'], share['id']
        self.assertEqual(self.visitor.get(f'/api/shared/{token}').json['meals'][0]['id'],mid)
        image_response = self.visitor.get(f'/api/shared/{token}/image/{mid}/sticker')
        self.assertEqual(image_response.status_code,200); image_response.close()
        self.assertEqual(self.bob.delete(f'/api/shares/{sid}').status_code,200)
        self.assertEqual(self.visitor.get(f'/api/shared/{token}').status_code,200)
        self.alice.delete(f'/api/shares/{sid}')
        self.assertEqual(self.visitor.get(f'/api/shared/{token}').status_code,404)
        self.assertEqual(self.visitor.get(f'/api/shared/{token}/image/{mid}/sticker').status_code,404)

    def test_settings_encrypted_and_origin_rejected(self):
        resp=self.alice.put('/api/settings',json={'provider':'deepseek','api_key':'test-secret-value','model':'deepseek-flash','target':1900})
        self.assertEqual(resp.status_code,200)
        self.assertNotIn('test-secret-value',str(resp.json))
        with application.app.app_context():
            row=application.db().execute("SELECT api_key FROM users WHERE provider='deepseek' ORDER BY id DESC LIMIT 1").fetchone()
            self.assertNotIn('test-secret-value',row['api_key'])
        resp=self.alice.put('/api/settings',json={'provider':'openai','target':1900})
        self.assertFalse(resp.json['user']['has_key'])
        self.assertEqual(self.alice.post('/api/shares',json={'day':'2026-11-13'},headers={'Origin':'https://bad.example'}).status_code,403)

    def test_validation_and_update(self):
        self.assertEqual(self.visitor.get('/api/meals?day=2026-11-13').status_code,401)
        self.assertEqual(self.alice.post('/api/meals',json={'day':'2026-13-99','name':'x'}).status_code,400)
        self.assertEqual(self.alice.put('/api/water',json={'day':'2026-11-13','amount':500}).json['amount'],500)
        self.assertEqual(self.alice.post('/api/weights',json={'day':'2026-11-13','weight':62.5}).json['weights'][0]['weight'],62.5)

    def test_delete_account_revokes_shares_and_data(self):
        meal = {'day':'2026-11-13','category':'lunch','name':'测试','calories':100,'photo':photo_data()}
        self.assertEqual(self.alice.post('/api/meals',json=meal).status_code,201)
        token=self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]['token']
        self.assertEqual(self.alice.delete('/api/account',json={'password':'wrong'}).status_code,401)
        self.assertEqual(self.alice.delete('/api/account',json={'password':'long-password'}).status_code,200)
        self.assertEqual(self.alice.get('/api/me').json['user'],None)
        self.assertEqual(self.visitor.get(f'/api/shared/{token}').status_code,404)

    def test_vision_request(self):
        import json
        import ai
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps({'choices':[{'message':{'content':json.dumps({'name':'米饭','grams':200,'calories':230,'carbs':50,'protein':5,'fat':1})}}]}).encode()
        with patch.object(ai,'urlopen',return_value=Response()) as fake:
            result=ai.vision_recognize(Image.new('RGB',(20,20)), 'deepseek', 'test-key', 'deepseek-flash')
            payload=json.loads(fake.call_args.args[0].data)
            self.assertEqual(result['name'],'米饭')
            self.assertEqual(payload['model'],'deepseek-flash')
            self.assertTrue(payload['messages'][0]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,'))


if __name__=='__main__':unittest.main()
