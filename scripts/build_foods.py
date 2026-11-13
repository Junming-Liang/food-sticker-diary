"""Build the small, Chinese-labelled food catalog from USDA SR Legacy CSV.

Usage: python scripts/build_foods.py /path/to/FoodData_Central_sr_legacy_food_csv_2018-04.zip
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
FIELDS = {'1008':'calories','1005':'carbs','1003':'protein','1004':'fat'}


def main(path):
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
        foods.append(dict(id=fdc_id,name=name,keywords=keywords,source_name=descriptions[fdc_id],**values[fdc_id]))
    output={'source':'USDA FoodData Central, SR Legacy, April 2018','unit':'per 100 g','foods':foods}
    dest=Path(__file__).resolve().parent.parent/'web'/'foods.json'
    dest.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(f'{len(foods)} foods written to {dest}')


if __name__=='__main__':
    if len(sys.argv)!=2: raise SystemExit(__doc__)
    main(sys.argv[1])
