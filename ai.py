"""Photo processing and optional vision providers; models stay outside the repository."""
import base64
import io
import json
import os
import re
import threading
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image, ImageOps

MODEL_DIR = Path(os.environ.get('FOOD_MODELS', Path(__file__).parent / 'models'))
_lock = threading.BoundedSemaphore(1)  # minimal: one inference at a time protects the shared small server.
_sessions = {}

# Local model recognizes whole dishes, not ingredients; no invented nutrition values.
TRANSLATIONS = {
    'apple_pie':'苹果派','baby_back_ribs':'烤排骨','beef_carpaccio':'生牛肉片','beef_tartare':'鞑靼牛肉',
    'beet_salad':'甜菜沙拉','beignets':'法式甜甜圈','bibimbap':'韩式拌饭','bread_pudding':'面包布丁',
    'breakfast_burrito':'早餐卷饼','bruschetta':'意式烤面包','caesar_salad':'凯撒沙拉','cannoli':'意式奶油卷',
    'caprese_salad':'番茄芝士沙拉','carrot_cake':'胡萝卜蛋糕','ceviche':'酸橘汁腌鱼','cheesecake':'芝士蛋糕',
    'cheese_plate':'奶酪拼盘','chicken_curry':'咖喱鸡','chicken_quesadilla':'鸡肉芝士饼','chicken_wings':'鸡翅',
    'chocolate_cake':'巧克力蛋糕','chocolate_mousse':'巧克力慕斯','churros':'西班牙油条','clam_chowder':'蛤蜊浓汤',
    'club_sandwich':'三明治','crab_cakes':'蟹肉饼','creme_brulee':'焦糖布丁','croque_madame':'火腿芝士三明治',
    'cup_cakes':'纸杯蛋糕','deviled_eggs':'魔鬼蛋','donuts':'甜甜圈','dumplings':'饺子','edamame':'毛豆',
    'eggs_benedict':'班尼迪克蛋','escargots':'焗蜗牛','falafel':'鹰嘴豆丸子','filet_mignon':'菲力牛排',
    'fish_and_chips':'炸鱼薯条','foie_gras':'鹅肝','french_fries':'薯条','french_onion_soup':'法式洋葱汤',
    'french_toast':'法式吐司','fried_calamari':'炸鱿鱼','fried_rice':'炒饭','frozen_yogurt':'冻酸奶',
    'garlic_bread':'蒜香面包','gnocchi':'意式面疙瘩','greek_salad':'希腊沙拉','grilled_cheese_sandwich':'烤芝士三明治',
    'grilled_salmon':'烤三文鱼','guacamole':'牛油果酱','gyoza':'煎饺','hamburger':'汉堡','hot_and_sour_soup':'酸辣汤',
    'hot_dog':'热狗','huevos_rancheros':'墨西哥煎蛋','hummus':'鹰嘴豆泥','ice_cream':'冰淇淋',
    'lasagna':'千层面','lobster_bisque':'龙虾浓汤','lobster_roll_sandwich':'龙虾三明治','macaroni_and_cheese':'芝士通心粉',
    'macarons':'马卡龙','miso_soup':'味噌汤','mussels':'贻贝','nachos':'墨西哥玉米片','omelette':'煎蛋卷',
    'onion_rings':'洋葱圈','oysters':'生蚝','pad_thai':'泰式炒河粉','paella':'西班牙海鲜饭','pancakes':'松饼',
    'panna_cotta':'意式奶冻','peking_duck':'北京烤鸭','pho':'越南河粉','pizza':'披萨','pork_chop':'猪排',
    'poutine':'肉汁芝士薯条','prime_rib':'烤牛肋排','pulled_pork_sandwich':'手撕猪肉三明治','ramen':'拉面',
    'ravioli':'意式饺子','red_velvet_cake':'红丝绒蛋糕','risotto':'意式烩饭','samosa':'咖喱角',
    'sashimi':'刺身','scallops':'扇贝','seaweed_salad':'海藻沙拉','shrimp_and_grits':'虾仁玉米粥',
    'spaghetti_bolognese':'肉酱意面','spaghetti_carbonara':'奶油培根意面','spring_rolls':'春卷','steak':'牛排',
    'strawberry_shortcake':'草莓蛋糕','sushi':'寿司','tacos':'墨西哥玉米饼','takoyaki':'章鱼小丸子',
    'tiramisu':'提拉米苏','tuna_tartare':'金枪鱼塔塔','waffles':'华夫饼',
}


def session(name):
    if name not in _sessions:
        import onnxruntime as ort
        path = MODEL_DIR / name
        if not path.is_file():
            raise FileNotFoundError(name)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2
        opts.inter_op_num_threads = 1
        # Release temporary inference buffers between photos on the shared server.
        opts.enable_cpu_mem_arena = False
        opts.enable_mem_pattern = False
        _sessions[name] = ort.InferenceSession(str(path), sess_options=opts, providers=['CPUExecutionProvider'])
    return _sessions[name]


def jpeg_bytes(image):
    stream = io.BytesIO()
    image.convert('RGB').save(stream, 'JPEG', quality=88, optimize=True)
    return stream.getvalue()


def sticker(image):
    """U2NetP produces a subject alpha matte; return a transparent PNG."""
    with _lock:
        model = session('u2netp.onnx')
        src = image.convert('RGB')
        array = np.asarray(src.resize((320, 320), Image.Resampling.BILINEAR), dtype=np.float32) / 255.0
        array = (array - np.array([.485,.456,.406], dtype=np.float32)) / np.array([.229,.224,.225], dtype=np.float32)
        x = np.transpose(array, (2, 0, 1))[None]
        mask = model.run(None, {model.get_inputs()[0].name: x})[0][0, 0]
        low, high = float(mask.min()), float(mask.max())
        if high - low < 1e-8:
            raise ValueError('无法从照片中提取食物')
        mask = np.uint8(np.clip((mask - low) / (high - low) * 255, 0, 255))
        alpha = Image.fromarray(mask).resize(src.size, Image.Resampling.LANCZOS)
        src.putalpha(alpha)
        stream = io.BytesIO()
        src.save(stream, 'PNG', optimize=True)
        return stream.getvalue()


def local_recognize(image):
    with _lock:
        model = session('food101.onnx')
        with (MODEL_DIR / 'food101-config.json').open() as f:
            labels = json.load(f)['id2label']
        array = np.asarray(image.convert('RGB').resize((224, 224), Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
        array = (array - np.array([.485,.456,.406], dtype=np.float32)) / np.array([.229,.224,.225], dtype=np.float32)
        x = np.transpose(array, (2, 0, 1))[None]
        logits = model.run(None, {model.get_inputs()[0].name: x})[0][0]
        probs = np.exp(logits - np.max(logits)); probs /= probs.sum()
        return [{'name': TRANSLATIONS.get(labels[str(int(i))], labels[str(int(i))].replace('_',' ')),
                 'confidence': round(float(probs[i]), 3)} for i in np.argsort(probs)[-3:][::-1]]


def vision_recognize(image, provider, key, model):
    # Fixed provider URLs avoid exposing the server to user-supplied URL requests.
    endpoints = {'openai': 'https://api.openai.com/v1/chat/completions',
                 'deepseek': 'https://api.deepseek.com/chat/completions'}
    prompt = ('识别这张食物照片，估算整份餐食的名称、重量和营养。只返回一个 JSON 对象，'
              '字段为 name（简体中文）、grams（克）、calories（千卡）、carbs、protein、fat（后三者单位均为克）。'
              '如有多种食物，计算整份合计并在名称中概括。无法判断时合理估计，不要添加 Markdown。')
    data_url = 'data:image/jpeg;base64,' + base64.b64encode(jpeg_bytes(image)).decode()
    body = {'model': model, 'messages': [{'role': 'user', 'content': [
        {'type': 'text', 'text': prompt}, {'type': 'image_url', 'image_url': {'url': data_url}}]}],
        'response_format': {'type':'json_object'}, 'max_tokens': 500}
    req = Request(endpoints[provider], data=json.dumps(body, ensure_ascii=False).encode(), method='POST',
                  headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urlopen(req, timeout=75) as response:
            if response.status != 200:
                raise ValueError('识别服务暂不可用')
            text = json.load(response)['choices'][0]['message']['content']
        parsed = json.loads(re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip()))
        result = {'name': str(parsed.get('name', ''))[:80]}
        if not result['name']:
            raise ValueError('识别结果缺少食物名称')
        for field in ('grams','calories','carbs','protein','fat'):
            value = float(parsed.get(field, 0))
            if not np.isfinite(value) or not 0 <= value <= 100000:
                raise ValueError('识别结果格式有误')
            result[field] = round(value, 1)
        return result
    except HTTPError as exc:
        if exc.code in (401,403): raise ValueError('API 密钥无效或没有权限，请在设置中检查') from exc
        if exc.code == 429: raise ValueError('识别服务额度不足或请求过多，请稍后再试') from exc
        raise ValueError(f'识别服务返回错误（{exc.code}），请检查模型名称与服务状态') from exc
    except (URLError, TimeoutError) as exc:
        raise ValueError('无法连接识别服务，请检查网络后重试') from exc
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError('识别结果无法读取，请重试或手动填写') from exc
