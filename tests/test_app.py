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
        application._attempts.clear()
        self.alice = application.app.test_client(); self.bob = application.app.test_client(); self.visitor = application.app.test_client()
        suffix = os.urandom(6).hex()
        self.assertEqual(self.alice.post('/api/auth/register',json={'username':'alice'+suffix,'password':'long-password'}).status_code,200)
        self.assertEqual(self.bob.post('/api/auth/register',json={'username':'bob'+suffix,'password':'long-password'}).status_code,200)

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

    def test_shared_stickers_hide_original_photo_and_transparent_pixel_data(self):
        background=Image.new('RGBA',(20,20),(19,51,94,0))
        background.putpixel((10,10),(220,70,20,255))
        background.putpixel((1,1),(19,51,94,5))
        stream=io.BytesIO();background.save(stream,format='PNG')
        sticker='data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()
        payload={'day':'2026-11-13','category':'lunch','name':'测试餐','calories':180,
                 'photo':photo_data(),'sticker':sticker}
        meal=self.alice.post('/api/meals',json=payload).json['meal'];mid=meal['id']
        # A legacy sticker may still contain the entire original image in transparent RGB pixels.
        with application.app.app_context():
            row=application.db().execute('SELECT user_id,sticker FROM meals WHERE id=?',(mid,)).fetchone()
            path=application.UPLOADS / str(row['user_id']) / row['sticker']
            path.write_bytes(stream.getvalue())
        token=self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]['token']
        visible=self.visitor.get(f'/api/shared/{token}').json['meals'][0]
        self.assertFalse(visible['has_photo'])
        self.assertEqual(self.visitor.get(f'/api/shared/{token}/image/{mid}/photo').status_code,404)
        response=self.visitor.get(f'/api/shared/{token}/image/{mid}/sticker')
        image=Image.open(io.BytesIO(response.data)).convert('RGBA')
        self.assertEqual(image.getpixel((0,0)),(0,0,0,0))
        self.assertEqual(image.getpixel((1,1)),(0,0,0,0))
        self.assertEqual(image.getpixel((10,10)),(220,70,20,255))
        self.assertEqual(path.read_bytes(),stream.getvalue())
        owner_photo=self.alice.get(f'/api/meals/{mid}/photo')
        self.assertEqual(owner_photo.status_code,200); owner_photo.close()
        invite=self.alice.post('/api/buddy/invites',json={}).json['token']
        self.bob.post('/api/buddy/accept',json={'token':invite})
        self.assertFalse(self.bob.get('/api/buddy?day=2026-11-13').json['meals'][0]['has_photo'])
        self.assertEqual(self.bob.get(f'/api/buddy/meals/{mid}/photo').status_code,404)
        buddy_image=self.bob.get(f'/api/buddy/meals/{mid}/sticker')
        self.assertEqual(buddy_image.status_code,200); buddy_image.close()

    def test_thumbnail_preserves_full_image_and_access_controls(self):
        image=Image.new('RGBA',(768,512),(19,51,94,0))
        image.paste((220,70,20,255),(100,100,600,400))
        stream=io.BytesIO(); image.save(stream,format='PNG')
        payload={'day':'2026-11-13','category':'lunch','name':'测试','calories':100,
                 'photo':photo_data(),'sticker':'data:image/png;base64,'+base64.b64encode(stream.getvalue()).decode()}
        mid=self.alice.post('/api/meals',json=payload).json['meal']['id']
        with application.app.app_context():
            row=application.db().execute('SELECT user_id,sticker FROM meals WHERE id=?',(mid,)).fetchone()
            original=application.UPLOADS/str(row['user_id'])/row['sticker']
            thumb=original.with_name(original.name+'.thumb')
            self.assertTrue(thumb.is_file())
        response=self.alice.get(f'/api/meals/{mid}/sticker?size=thumbnail')
        self.assertEqual(Image.open(io.BytesIO(response.data)).size,(384,256));response.close()
        full=self.alice.get(f'/api/meals/{mid}/sticker')
        self.assertEqual(Image.open(io.BytesIO(full.data)).size,(768,512));full.close()
        self.assertEqual(self.bob.get(f'/api/meals/{mid}/sticker?size=thumbnail').status_code,404)
        token=self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]['token']
        thumb.unlink()  # Existing records are populated on their first request.
        response=self.visitor.get(f'/api/shared/{token}/image/{mid}/sticker?size=thumbnail')
        small=Image.open(io.BytesIO(response.data)).convert('RGBA')
        self.assertEqual(small.size,(384,256)); self.assertEqual(small.getpixel((0,0)),(0,0,0,0));response.close()
        self.assertTrue(thumb.is_file())
        self.assertEqual(self.visitor.get(f'/api/shared/{token}/image/{mid}/photo?size=thumbnail').status_code,404)
        self.alice.delete(f'/api/meals/{mid}')
        self.assertFalse(original.exists());self.assertFalse(thumb.exists())

    def test_macronutrient_goals_are_optional_and_persist(self):
        response=self.alice.put('/api/settings',json={'target':1900,'carbs_goal':200,'protein_goal':95.5,'fat_goal':''})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json['user']['carbs_goal'],200)
        self.assertEqual(response.json['user']['protein_goal'],95.5)
        self.assertIsNone(response.json['user']['fat_goal'])
        response=self.alice.put('/api/settings',json={'provider':'deepseek','model':'deepseek-flash-custom','target':1850})
        self.assertEqual(response.json['user']['carbs_goal'],200)
        response=self.alice.put('/api/settings',json={'target':1800})
        self.assertEqual(response.json['user']['model'],'deepseek-flash-custom')
        self.assertEqual(self.alice.put('/api/settings',json={'carbs_goal':0.04}).status_code,400)
        self.assertIsNone(self.bob.get('/api/me').json['user']['carbs_goal'])

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
        self.assertEqual(self.bob.delete('/api/weights/2026-11-13').status_code,404)
        self.assertEqual(self.alice.delete('/api/weights/2026-11-13').status_code,200)
        self.assertEqual(self.alice.get('/api/weights').json['weights'],[])

    def test_photo_save_keeps_disk_reserve(self):
        from types import SimpleNamespace
        data={'day':'2026-11-13','category':'lunch','name':'测试','calories':100,'photo':photo_data()}
        with patch.object(application.shutil,'disk_usage',return_value=SimpleNamespace(free=100)):
            response=self.alice.post('/api/meals',json=data)
        self.assertEqual(response.status_code,400)
        self.assertEqual(self.alice.get('/api/meals?day=2026-11-13').json['meals'],[])

    def test_photo_jobs_are_bounded(self):
        application._photo_lock.acquire()
        try:
            response=self.alice.post('/api/analyze',data={})
            self.assertEqual(response.status_code,429)
        finally:
            application._photo_lock.release()

    def test_account_deletion_unbinds_buddy(self):
        token=self.alice.post('/api/buddy/invites',json={}).json['token']
        self.bob.post('/api/buddy/accept',json={'token':token})
        self.assertTrue(self.bob.get('/api/buddy?day=2026-11-13').json['paired'])
        self.assertEqual(self.alice.delete('/api/account',json={'password':'long-password'}).status_code,200)
        self.assertFalse(self.bob.get('/api/buddy?day=2026-11-13').json['paired'])

    def test_existing_meal_schema_migrates_without_data_loss(self):
        import sqlite3,subprocess,sys
        with tempfile.TemporaryDirectory(prefix='food-diary-migration-') as directory:
            conn=sqlite3.connect(os.path.join(directory,'diary.sqlite3'))
            conn.execute("""CREATE TABLE users (id INTEGER PRIMARY KEY,username TEXT UNIQUE,password TEXT,target INTEGER,
                         provider TEXT,model TEXT,api_key TEXT,created INTEGER)""")
            conn.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?)",(1,'legacy','hash',1900,'local','','',1))
            conn.execute("""CREATE TABLE meals (id TEXT PRIMARY KEY,user_id INTEGER,day TEXT,category TEXT,name TEXT,
                         grams REAL,calories REAL,carbs REAL,protein REAL,fat REAL,image TEXT,sticker TEXT,created INTEGER)""")
            conn.execute("INSERT INTO meals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",('old',1,'2026-11-13','lunch','旧记录',100,123,1,2,3,None,None,1))
            conn.commit();conn.close()
            environment=dict(os.environ,FOOD_DATA=directory)
            result=subprocess.run([sys.executable,'-c',"import app; print(app.DATA)"],env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            conn=sqlite3.connect(os.path.join(directory,'diary.sqlite3'))
            self.assertEqual(conn.execute("SELECT name,calories,components FROM meals WHERE id='old'").fetchone(),('旧记录',123.0,'[]'))
            self.assertEqual(conn.execute("SELECT username,target,carbs_goal,protein_goal,fat_goal FROM users WHERE id=1").fetchone(),('legacy',1900,None,None,None))
            conn.close()

    def test_meal_components_are_persisted_and_totals_are_authoritative(self):
        components=[{'name':'米饭','grams':150,'calories':195,'carbs':42.3,'protein':4,'fat':0.4},
                    {'name':'鸡蛋','grams':100,'calories':155,'carbs':1,'protein':13,'fat':11}]
        payload={'day':'2026-11-13','category':'lunch','name':'米饭与鸡蛋','calories':9999,'components':components}
        response=self.alice.post('/api/meals',json=payload)
        self.assertEqual(response.status_code,201)
        meal=response.json['meal'];self.assertEqual(meal['calories'],350);self.assertEqual(meal['grams'],250)
        self.assertEqual([x['name'] for x in meal['components']],['米饭','鸡蛋'])
        mid=meal['id']
        self.assertEqual(self.alice.put(f'/api/meals/{mid}',json={'day':'2026-11-13','category':'lunch','name':'旧客户端'}).status_code,409)
        components[0]['calories']=200
        self.assertEqual(self.alice.put(f'/api/meals/{mid}',json=payload).json['meal']['calories'],355)
        self.assertEqual(self.bob.get('/api/meals?day=2026-11-13').json['meals'],[])
        share=self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]['token']
        self.assertEqual(len(self.visitor.get(f'/api/shared/{share}').json['meals'][0]['components']),2)
        payload['components']=[{'name':'bad','calories':-1}]
        self.assertEqual(self.alice.put(f'/api/meals/{mid}',json=payload).status_code,400)

    def test_vision_result_sums_multiple_foods(self):
        import ai,json
        content={'name':'米饭和鸡蛋','uncertainty_note':'做法需要确认','components':[{'name':'米饭','grams':100,'calories':130,'carbs':28,'protein':3,'fat':0.3},
                                                  {'name':'鸡蛋','grams':50,'calories':78,'carbs':0.5,'protein':6,'fat':5}]}
        with patch.object(ai,'provider_response',return_value={'choices':[{'message':{'content':json.dumps(content)}}]}):
            result=ai.vision_recognize(Image.new('RGB',(20,20)),'openai','test-key','gpt-4o-mini')
        self.assertEqual(result['calories'],208)
        self.assertEqual(result['grams'],150)
        self.assertEqual(len(result['components']),2)
        self.assertEqual(result['uncertainty_note'],'做法需要确认')

    def test_openai_request_and_model_access_error(self):
        import ai,json
        from urllib.error import HTTPError
        content={'name':'米饭','grams':100,'calories':130}
        with patch.object(ai,'provider_response',return_value={'choices':[{'message':{'content':json.dumps(content)}}]}) as provider:
            ai.vision_recognize(Image.new('RGB',(20,20)),'openai','test-key','gpt-6.1-terra')
            payload=json.loads(provider.call_args.args[0].data)
        self.assertEqual(payload['model'],'gpt-6.1-terra')
        self.assertEqual(payload['max_completion_tokens'],1500)
        self.assertNotIn('max_tokens',payload)
        error=HTTPError('https://api.openai.com/v1/chat/completions',404,'not found',{},io.BytesIO(b'{"error":{"code":"model_not_found"}}'))
        with patch.object(ai,'provider_response',side_effect=error):
            with self.assertRaisesRegex(ValueError,'项目没有权限'):
                ai.vision_recognize(Image.new('RGB',(20,20)),'openai','test-key','gpt-6.1-terra')

    def test_exercise_is_private_and_editable(self):
        payload={'day':'2026-11-13','name':'散步','minutes':30,'calories':120}
        self.assertEqual(self.alice.post('/api/exercises',json=payload).status_code,201)
        entry=self.alice.get('/api/exercises?day=2026-11-13').json['exercises'][0]
        self.assertEqual(entry['calories'],120)
        self.assertEqual(self.bob.get('/api/exercises?day=2026-11-13').json['exercises'],[])
        self.assertEqual(self.bob.delete(f"/api/exercises/{entry['id']}").status_code,404)
        payload['calories']=150
        self.assertEqual(self.alice.put(f"/api/exercises/{entry['id']}",json=payload).status_code,200)
        self.assertEqual(self.alice.get('/api/exercises?day=2026-11-13').json['exercises'][0]['calories'],150)
        self.assertEqual(self.alice.delete(f"/api/exercises/{entry['id']}").status_code,200)

    def test_fasting_timer_is_private_and_records_actual_end(self):
        self.assertEqual(self.alice.post('/api/fasts',json={'goal_hours':16}).status_code,200)
        self.assertEqual(self.alice.post('/api/fasts',json={'goal_hours':16}).status_code,409)
        active=self.alice.get('/api/fasts').json['fasts'][0]
        self.assertIsNone(active['ended'])
        self.assertEqual(self.bob.get('/api/fasts').json['fasts'],[])
        self.assertEqual(self.bob.post('/api/fasts/end',json={}).status_code,404)
        self.assertEqual(self.alice.delete(f"/api/fasts/{active['id']}").status_code,404)
        self.assertEqual(self.alice.post('/api/fasts/end',json={}).status_code,200)
        finished=self.alice.get('/api/fasts').json['fasts'][0]
        self.assertGreaterEqual(finished['ended'],finished['started'])
        self.assertEqual(self.alice.delete(f"/api/fasts/{active['id']}").status_code,200)

    def test_buddy_sharing_requires_consent_and_can_be_paused(self):
        payload={'day':'2026-11-13','category':'lunch','name':'测试餐','calories':180,'photo':photo_data(),'sticker':photo_data('RGBA')}
        mid=self.alice.post('/api/meals',json=payload).json['meal']['id']
        token=self.alice.post('/api/buddy/invites',json={}).json['token']
        self.assertEqual(self.alice.post('/api/buddy/accept',json={'token':token}).status_code,400)
        self.assertEqual(self.bob.get(f'/api/buddy/invites/{token}').status_code,200)
        self.assertEqual(self.bob.post('/api/buddy/accept',json={'token':token}).status_code,200)
        self.assertEqual(self.bob.get(f'/api/buddy/invites/{token}').status_code,404)
        result=self.bob.get('/api/buddy?day=2026-11-13').json
        self.assertEqual(result['meals'][0]['id'],mid)
        image_response=self.bob.get(f'/api/buddy/meals/{mid}/sticker')
        self.assertEqual(image_response.status_code,200); image_response.close()
        self.assertEqual(self.visitor.get(f'/api/buddy/meals/{mid}/photo').status_code,401)
        self.alice.put('/api/buddy/sharing',json={'enabled':False})
        self.assertFalse(self.bob.get('/api/buddy?day=2026-11-13').json['other_sharing'])
        self.assertEqual(self.bob.get(f'/api/buddy/meals/{mid}/sticker').status_code,404)
        self.alice.put('/api/buddy/sharing',json={'enabled':True})
        self.assertEqual(len(self.bob.get('/api/buddy?day=2026-11-13').json['meals']),1)
        self.bob.delete('/api/buddy')
        self.assertFalse(self.alice.get('/api/buddy?day=2026-11-13').json['paired'])
        self.assertEqual(self.bob.get(f'/api/buddy/meals/{mid}/sticker').status_code,404)

    def test_delete_account_revokes_shares_and_data(self):
        meal = {'day':'2026-11-13','category':'lunch','name':'测试','calories':100,'photo':photo_data()}
        self.assertEqual(self.alice.post('/api/meals',json=meal).status_code,201)
        token=self.alice.post('/api/shares',json={'day':'2026-11-13'}).json['shares'][0]['token']
        self.assertEqual(self.alice.delete('/api/account',json={'password':'wrong'}).status_code,401)
        self.assertEqual(self.alice.delete('/api/account',json={'password':'long-password'}).status_code,200)
        self.assertEqual(self.alice.get('/api/me').json['user'],None)
        self.assertEqual(self.visitor.get(f'/api/shared/{token}').status_code,404)

    def test_openai_tunnel_keeps_the_official_tls_hostname(self):
        import ai
        from unittest.mock import MagicMock
        connection=ai.OpenAITunnelConnection(18796)
        connection._context=MagicMock()
        raw=MagicMock()
        with patch.object(ai.socket,'create_connection',return_value=raw) as create:
            connection.connect()
        self.assertEqual(create.call_args.args[0],('127.0.0.1',18796))
        self.assertEqual(connection._context.wrap_socket.call_args.kwargs['server_hostname'],'api.openai.com')

    def test_openai_tunnel_sends_only_to_expected_path(self):
        import ai
        from unittest.mock import MagicMock
        from urllib.request import Request
        response=MagicMock(status=200)
        response.read.return_value=b'{"ok":true}'
        connection=MagicMock()
        connection.getresponse.return_value=response
        request=Request('https://api.openai.com/v1/chat/completions',data=b'{}',headers={'Authorization':'Bearer example'})
        with patch.dict(os.environ,{'FOOD_OPENAI_TUNNEL_PORT':'18796'}), patch.object(ai,'OpenAITunnelConnection',return_value=connection) as factory:
            self.assertEqual(ai.provider_response(request,'openai'),{'ok':True})
        factory.assert_called_once_with(18796)
        self.assertEqual(connection.request.call_args.args[:2],('POST','/v1/chat/completions'))
        connection.close.assert_called_once()

    def test_openai_model_check_is_authenticated_and_uses_saved_settings(self):
        import ai
        from unittest.mock import MagicMock
        connection=MagicMock();response=MagicMock(status=200);response.read.return_value=b'{"id":"gpt-6.1-terra"}'
        connection.getresponse.return_value=response
        with patch.dict(os.environ,{'FOOD_OPENAI_TUNNEL_PORT':'18796'}), patch.object(ai,'OpenAITunnelConnection',return_value=connection):
            ai.check_openai_model('test-key','gpt-6.1-terra')
        self.assertEqual(connection.request.call_args.args[:2],('GET','/v1/models/gpt-6.1-terra'))
        self.assertEqual(self.visitor.post('/api/settings/check',json={}).status_code,401)
        self.alice.put('/api/settings',json={'provider':'openai','model':'gpt-6.1-terra','api_key':'test-key'})
        with patch.object(ai,'check_openai_model') as check:
            result=self.alice.post('/api/settings/check',json={})
        self.assertEqual(result.status_code,200)
        self.assertNotIn('test-key',str(result.json))
        check.assert_called_once_with('test-key','gpt-6.1-terra')

    def test_vision_request(self):
        import json
        import ai
        class Response:
            status=200
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return json.dumps({'choices':[{'message':{'content':json.dumps({'name':'米饭','grams':200,'calories':230,'carbs':50,'protein':5,'fat':1})}}]}).encode()
        with patch.dict(os.environ, {'FOOD_OPENAI_TUNNEL_PORT':'18796'}), patch.object(ai,'urlopen',return_value=Response()) as fake:
            result=ai.vision_recognize(Image.new('RGB',(20,20)), 'deepseek', 'test-key', 'deepseek-flash')
            payload=json.loads(fake.call_args.args[0].data)
            self.assertEqual(result['name'],'米饭')
            self.assertEqual(payload['model'],'deepseek-flash')
            self.assertTrue(payload['messages'][0]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,'))


if __name__=='__main__':unittest.main()
