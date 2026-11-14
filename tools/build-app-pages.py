#!/usr/bin/env python3
"""Generate crawlable application pages and sitemap with Python's standard library."""
import json
import re
from datetime import date
from html import escape
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://pgostation.github.io/HyperZebra-site/'
RELEASES = 'https://github.com/pgostation/HyperZebra/releases'


def e(value):
    return escape(str(value), quote=True)


def schema(value):
    return '<script type="application/ld+json">' + json.dumps(value, ensure_ascii=False).replace('<', '\\u003c') + '</script>'


def page(title, description, path, content, structured, prefix, image=None):
    url = BASE + path
    image_meta = f'\n  <meta property="og:image" content="{e(BASE + image)}">' if image else ''
    return f'''<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(description)}">
  <meta name="theme-color" content="#faf9f6">
  <link rel="canonical" href="{e(url)}">
  <meta property="og:type" content="website">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(description)}">
  <meta property="og:url" content="{e(url)}">{image_meta}
  <link rel="stylesheet" href="{prefix}assets/style.css">
  {schema(structured)}
</head>
<body id="top">
<a class="skip-link" href="#main">本文へ移動</a>
<div class="shell">
  <header class="site-header">
    <a class="wordmark" href="{prefix}index.html">HyperZebra</a>
    <nav class="header-links" aria-label="サイト内リンク"><a href="{prefix}apps/">アプリ一覧</a><a href="https://github.com/pgostation/HyperZebra">GitHub</a></nav>
  </header>
  <main id="main" class="catalog-main">
{content}
  </main>
  <footer class="site-footer"><div class="footer-notices"><p>HyperZebraは非公式の互換環境です。Apple Inc.とは関係がありません。</p><p>掲載アプリ・スタックおよび商標の権利は各権利者に帰属します。アプリ本体はこのサイトでは配布していません。</p></div><a href="#top">上に戻る ↑</a></footer>
</div>
</body>
</html>
'''


def build():
    apps = json.loads((ROOT / 'catalog/apps.json').read_text())
    slugs = set()
    for app in apps:
        slug = app['slug']
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug) or slug in slugs:
            raise ValueError(f'Invalid or duplicate slug: {slug}')
        slugs.add(slug)
        for key in ('name', 'kind', 'summary', 'intro', 'observed', 'caption', 'alt', 'record_note'):
            if not app[key].strip():
                raise ValueError(f'{slug}: missing {key}')
        for key in ('checked_on', 'updated_on'):
            if app[key]:
                date.fromisoformat(app[key])
        image_path = (ROOT / app['image']).resolve()
        if not image_path.is_relative_to(ROOT) or not image_path.is_file():
            raise ValueError(f'{slug}: invalid image')
        if app['width'] <= 0 or app['height'] <= 0:
            raise ValueError(f'{slug}: invalid image dimensions')
    apps.sort(key=lambda a: a['name'].casefold())
    links = []
    for app in apps:
        slug, name = app['slug'], app['name']
        path = f'apps/{slug}/'
        url = BASE + path
        prefix = '../../'
        fields = [('アプリ名 / スタック名', name), ('バージョン', app['app_version']),
                  ('確認日', app['checked_on']), ('HyperZebraのバージョン', app['hyperzebra_version']),
                  ('実行したOS（ホストOS）', app['host_os']), ('マシン・CPU・メモリ', app['machine'])]
        rows = []
        for label, value in fields:
            text = e(value) if value else '未記録'
            if label == '確認日' and value:
                text = f'<time datetime="{e(value)}">{e(value)}</time>'
            rows.append(f'<div><dt>{e(label)}</dt><dd>{text}</dd></div>')
        aliases = f'<p class="catalog-aliases">別名：{e("・".join(app["aliases"]))}</p>' if app['aliases'] else ''
        related = ''.join(f'<li><a href="../{e(other["slug"])}/">{e(other["name"])}の画面と動作情報</a></li>' for other in apps if other != app)
        content = f'''    <nav class="breadcrumbs" aria-label="パンくず"><a href="../../index.html">ホーム</a><span aria-hidden="true"> / </span><a href="../">アプリ一覧</a><span aria-hidden="true"> / </span><span aria-current="page">{e(name)}</span></nav>
    <article>
      <header class="catalog-heading">
        <p class="catalog-kind">{e(app['kind'])}</p>
        <h1>{e(name)}をHyperZebraで開く</h1>
        {aliases}
        <p>{e(app['intro'])}</p>
      </header>
      <figure class="app-screenshot">
        <a class="figure-link image-stage" href="{prefix}{e(app['image'])}"><img src="{prefix}{e(app['image'])}" width="{app['width']}" height="{app['height']}" alt="{e(app['alt'])}" fetchpriority="high" decoding="async"></a>
        <figcaption>{e(app['caption'])} 画像を選ぶと原寸で表示します。</figcaption>
      </figure>
      <section class="section" aria-labelledby="record-heading">
        <h2 id="record-heading">{e(name)}の動作確認情報</h2>
        <dl class="app-facts">{''.join(rows)}</dl>
        <p>{e(app['observed'])}</p>
        <p class="record-note">{e(app['record_note'])}</p>
        <p class="record-note">ページ更新日：<time datetime="{e(app['updated_on'])}">{e(app['updated_on'])}</time>（動作確認日とは異なります）</p>
      </section>
      <section class="section" aria-labelledby="open-heading">
        <h2 id="open-heading">手元の{e(name)}を開くには</h2>
        <p>HyperZebraは、HyperCardスタックやクラシックMacアプリを今のパソコンで開くための無料ソフトです。macOS・Windows・Linuxに対応しています。クラシックMacのROMやOSを用意したり、Finderからアプリを探したりする準備は不要です。</p>
        <ol class="app-open-steps"><li><a href="{RELEASES}">HyperZebraをダウンロード</a>して展開します。</li><li>利用できる{e(name)}のファイルを用意します。</li><li>HyperZebraを起動し、ランチャーへファイルをドロップします。アーカイブやディスクイメージにも対応しています。</li></ol>
        <p>動作はアプリの版や使用する機能、実行環境によって異なります。掲載画像は画面の表示例です。詳しい操作は<a href="../../index.html#start">使いかた</a>、設定については<a href="../../index.html#faq-mac">クラシックMacアプリのFAQ</a>をご覧ください。</p>
        <a class="download-button" href="{RELEASES}">HyperZebraをダウンロード <span aria-hidden="true">↓</span></a>
      </section>
    </article>
    <section class="section" aria-labelledby="related-heading"><h2 id="related-heading">ほかのアプリ・スタック</h2><ul class="catalog-links">{related}</ul><p><a href="../">すべてのアプリ・スタックを見る</a></p></section>'''
        structured = {'@context':'https://schema.org','@graph':[
            {'@type':'WebPage','@id':url,'url':url,'name':f'{name}をHyperZebraで開く — 画面と動作情報','description':app['summary'],'inLanguage':'ja','dateModified':app['updated_on'],'primaryImageOfPage':{'@type':'ImageObject','contentUrl':BASE+app['image'],'caption':app['caption'],'width':app['width'],'height':app['height']}},
            {'@type':'BreadcrumbList','itemListElement':[
                {'@type':'ListItem','position':1,'name':'HyperZebra','item':BASE},
                {'@type':'ListItem','position':2,'name':'アプリ一覧','item':BASE+'apps/'},
                {'@type':'ListItem','position':3,'name':name,'item':url}]}]}
        target = ROOT / path
        target.mkdir(parents=True, exist_ok=True)
        (target / 'index.html').write_text(page(f'{name}をHyperZebraで開く — 画面と動作情報',app['summary'],path,content,structured,prefix,app['image']))
        alias_text = f'（{e("・".join(app["aliases"]))}）' if app['aliases'] else ''
        links.append(f'<li><a href="{slug}/">{e(name)}{alias_text} — 画面と動作情報</a><span class="catalog-kind">{e(app["kind"])}</span></li>')
    index_content = f'''    <nav class="breadcrumbs" aria-label="パンくず"><a href="../index.html">ホーム</a><span aria-hidden="true"> / </span><span aria-current="page">アプリ一覧</span></nav>
    <header class="catalog-heading"><h1>アプリ・スタック一覧</h1><p>HyperZebraで開いたクラシックMacアプリとHyperCardスタックの画面・動作情報です。各ページでキャプチャ、アプリの版、確認日、HyperZebraの版、実行したOSとマシン情報を掲載します。</p><p>既存キャプチャに記録が残っていない項目は「未記録」としています。</p></header>
    <section class="section" aria-labelledby="all-apps"><h2 id="all-apps">掲載アプリ・スタック（{len(apps)}件）</h2><ul class="catalog-links">{''.join(links)}</ul></section>
    <p><a href="../index.html#start">HyperZebraの使いかた</a> · <a href="{RELEASES}">ダウンロード</a></p>'''
    structured = {'@context':'https://schema.org','@type':'CollectionPage','url':BASE+'apps/','name':'HyperZebraのアプリ・スタック一覧','inLanguage':'ja','mainEntity':{'@type':'ItemList','numberOfItems':len(apps),'itemListElement':[{'@type':'ListItem','position':i+1,'name':app['name'],'url':BASE+f'apps/{app["slug"]}/'} for i,app in enumerate(apps)]}}
    (ROOT/'apps/index.html').write_text(page('アプリ・スタック一覧 — HyperZebraの画面と動作情報','HyperZebraで開いたクラシックMacアプリとHyperCardスタックの一覧。アプリ別の画面キャプチャ、バージョン、確認日、OS・マシン情報を掲載。','apps/',index_content,structured,'../'))
    # Include every public HTML page, including future hand-authored pages.
    ns = 'http://www.sitemaps.org/schemas/sitemap/0.9'
    ET.register_namespace('', ns)
    sitemap = ET.Element(f'{{{ns}}}urlset')
    for target in sorted(ROOT.rglob('*.html')):
        relative = target.relative_to(ROOT).as_posix()
        if relative.startswith(('.', 'tools/')) or target.name.startswith('google'):
            continue
        path = relative[:-10] if relative.endswith('index.html') else relative
        item = ET.SubElement(sitemap, f'{{{ns}}}url')
        ET.SubElement(item, f'{{{ns}}}loc').text = BASE+path
    ET.indent(sitemap)
    ET.ElementTree(sitemap).write(ROOT/'sitemap.xml',encoding='utf-8',xml_declaration=True)
    print(f'Generated {len(apps)} application pages, index, and sitemap.')


if __name__ == '__main__':
    build()
