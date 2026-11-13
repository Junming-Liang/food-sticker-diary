"""Build the small, Chinese-labelled food catalog from USDA SR Legacy CSV.

Usage: python scripts/build_foods.py /path/to/sr_legacy.zip /path/to/fndds_2021-2023.zip
All nutrient amounts are per 100 g. Chinese names describe the source food and preparation.
"""
import csv
import io
import json
import sys
import zipfile
from pathlib import Path

FOODS = {
    '169757':('白米饭（熟，无盐）','米饭 大米 主食'),
    '169704':('糙米饭（熟）','糙米 米饭 主食'),
    '168484':('红薯（煮熟，去皮）','地瓜 番薯 薯类'),
    '170093':('烤土豆（带皮，无盐）','马铃薯 土豆 薯类'),
    '168928':('意大利面（熟，无盐）','意面 面条 主食'),
    '171662':('燕麦粥（即食燕麦加水）','麦片 粥 主食'),
    '172688':('全麦面包','吐司 面包 主食'),
    '169999':('甜玉米（煮熟，无盐）','玉米 棒子 主食'),
    '171477':('鸡胸肉（烤熟，无皮）','鸡肉 蛋白质 肉类'),
    '171793':('牛肉饼（熟，90%瘦肉）','牛肉 肉类 蛋白质'),
    '168250':('猪里脊（烤熟，瘦肉）','猪肉 肉类 蛋白质'),
    '171998':('三文鱼（熟，干热烹调）','鲑鱼 鱼肉 蛋白质'),
    '175180':('虾（熟）','虾仁 海鲜 蛋白质'),
    '173424':('鸡蛋（水煮）','水煮蛋 蛋类 蛋白质'),
    '172187':('鸡蛋（炒）','炒蛋 蛋类 蛋白质'),
    '172475':('硬豆腐（生，硫酸钙凝固）','豆腐 豆制品 蛋白质'),
    '171265':('全脂牛奶','牛奶 奶类'),
    '171269':('脱脂牛奶','牛奶 奶类'),
    '170894':('希腊酸奶（原味脱脂）','酸奶 奶类'),
    '171284':('全脂酸奶（原味）','酸奶 奶类'),
    '169283':('毛豆（煮熟，无盐）','黄豆 豆类 蛋白质'),
    '172421':('扁豆（煮熟，无盐）','豆类 蛋白质'),
    '173757':('鹰嘴豆（煮熟，无盐）','豆类 蛋白质'),
    '173806':('花生（干烤，无盐）','花生米 坚果'),
    '171688':('苹果（生，带皮）','苹果 水果'),
    '173944':('香蕉（生）','香蕉 水果'),
    '167762':('草莓（生）','草莓 水果'),
    '174683':('葡萄（生）','葡萄 水果'),
    '169097':('橙子（生）','橘子 柑橘 水果'),
    '167765':('西瓜（生）','西瓜 水果'),
    '169967':('西兰花（煮熟，无盐）','花椰菜 蔬菜'),
    '170457':('番茄（生）','西红柿 蔬菜'),
    '170393':('胡萝卜（生）','红萝卜 蔬菜'),
    '168409':('黄瓜（生，带皮）','青瓜 蔬菜'),
    '168462':('菠菜（生）','菠菜 蔬菜'),
    '169249':('生菜（生）','莴苣 蔬菜'),
    '171705':('牛油果（生）','鳄梨 水果'),
    '169251':('白蘑菇（生）','蘑菇 菌菇 蔬菜'),
    '169976':('卷心菜（煮熟，无盐）','包菜 圆白菜 蔬菜'),
    '169229':('茄子（煮熟，无盐）','茄子 蔬菜'),
    '171413':('橄榄油','食用油 油脂'),
    '170317':('芝士披萨（普通饼底，烤熟）','披萨 匹萨 比萨'),
}
FNDDS = {
    '2708951':('炒饭（无肉，参考配方）','炒饭 蛋炒饭 主食'),
    '2708952':('炒饭（未注明配料，参考配方）','炒饭 主食'),
    '2708953':('鸡肉炒饭（参考配方）','炒饭 鸡肉 主食'),
    '2708954':('猪肉炒饭（参考配方）','炒饭 猪肉 主食'),
    '2708956':('虾仁炒饭（参考配方）','炒饭 虾仁 主食'),
    '2708708':('蒸馄饨或蒸饺（参考配方）','饺子 馄饨 抄手 点心'),
    '2708705':('炸馄饨或煎饺（参考配方）','饺子 馄饨 锅贴 点心'),
    '2709160':('馄饨汤（参考配方）','馄饨 抄手 汤'),
    '2708959':('寿司（未注明种类，参考配方）','寿司 米饭'),
    '2708963':('三文鱼寿司卷（参考配方）','寿司 三文鱼 米饭'),
    '2708966':('蔬菜寿司卷（参考配方）','寿司 蔬菜 米饭'),
    '2709153':('拉面（未注明配料，参考配方）','拉面 面条'),
    '2709157':('素拉面（参考配方）','拉面 面条 素食'),
    '2709158':('拉面（含肉和蛋，参考配方）','拉面 面条 鸡蛋 肉'),
    '2708356':('米粉或米线（熟）','米线 米粉 面条'),
    '2707455':('味噌汤或豆腐汤（参考配方）','味噌 汤 豆腐'),
    '2706751':('酱油炒牛肉与蔬菜（参考配方）','炒牛肉 蔬菜 肉'),
    '2706764':('木须肉（不含饼，参考配方）','木须肉 猪肉'),
    '2707476':('酱油炒豆腐与蔬菜（参考配方）','豆腐 蔬菜'),
    '2706607':('牛肉炒面（美式中餐参考配方）','牛肉 炒面 面条'),
    '2708418':('米粥（参考配方）','粥 白粥 米粥'),
    '2708984':('蛋粥（参考配方）','粥 鸡蛋 米粥'),
}
FIELDS = {'1008':'calories','1005':'carbs','1003':'protein','1004':'fat'}


def main(path, survey_path):
    with zipfile.ZipFile(path) as archive:
        def read_table(name):
            member=next(n for n in archive.namelist() if n.endswith('/'+name))
            with archive.open(member) as src:
                return list(csv.DictReader(io.TextIOWrapper(src,encoding='utf-8')))
        descriptions={r['fdc_id']:r['description'] for r in read_table('food.csv') if r['fdc_id'] in FOODS}
        values={key:{} for key in FOODS}
        for row in read_table('food_nutrient.csv'):
            if row['fdc_id'] in values and row['nutrient_id'] in FIELDS and row['amount']:
                values[row['fdc_id']][FIELDS[row['nutrient_id']]]=float(row['amount'])
    foods=[]
    for fdc_id,(name,keywords) in FOODS.items():
        if fdc_id not in descriptions or set(values[fdc_id]) != set(FIELDS.values()):
            raise ValueError(f'Missing required nutrient or food for FDC {fdc_id}')
        foods.append(dict(id=fdc_id,name=name,keywords=keywords,source_name=descriptions[fdc_id],dataset='SR Legacy 2018',**values[fdc_id]))
    with zipfile.ZipFile(survey_path) as archive:
        with archive.open('surveyDownload.json') as source:
            survey={str(food['fdcId']):food for food in json.load(source)['SurveyFoods'] if str(food['fdcId']) in FNDDS}
    for fdc_id,(name,keywords) in FNDDS.items():
        item=survey[fdc_id]
        values={FIELDS[str(n['nutrient']['id'])]:float(n['amount']) for n in item['foodNutrients']
                if str(n['nutrient']['id']) in FIELDS and n.get('amount') is not None}
        if set(values)!=set(FIELDS.values()): raise ValueError(f'Missing nutrient for FDC {fdc_id}')
        foods.append(dict(id=fdc_id,name=name,keywords=keywords,source_name=item['description'],dataset='FNDDS 2021–2023',**values))
    output={'source':'USDA FoodData Central, SR Legacy 2018 and FNDDS 2021–2023','unit':'per 100 g','foods':foods}
    dest=Path(__file__).resolve().parent.parent/'web'/'foods.json'
    dest.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(foods)} foods written to {dest}')


if __name__=='__main__':
    if len(sys.argv)!=3: raise SystemExit(__doc__)
    main(sys.argv[1],sys.argv[2])
