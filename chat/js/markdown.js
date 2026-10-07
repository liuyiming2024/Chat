/* ------------------------------------------------------------------
 * markdown.js —— 自研轻量 Markdown 渲染器（GFM 子集）
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块 / 引用 /
 *       有序无序列表 / 表格 / 链接 / 图片 / 分隔线 / $LaTeX$ / $$块公式$$
 * 全部内容先转义再渲染，URL 走协议白名单，杜绝 XSS。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var SEP = '\uE000';

  /* @提及：把 @昵称 渲染成高亮标签。渲染前已完成 HTML 转义，
     这里只处理纯文本层，不会产生注入。 */
  function atHighlight(html) {
    return html.replace(/(^|[\s(（\[，,。.；;：:！!？?])@([^\s@<]{1,16})/g, function (m0, pre, name) {
      return pre + '<span class="at-mention" data-at="' + esc(name) + '">@' + esc(name) + '</span>';
    });
  }

  /* 极简代码高亮：仅对关键字/字符串/注释/数字着色，不引入任何第三方库 */
  var KEYWORDS = ('auto break case char const continue default do double else enum extern float for goto if inline int long '
    + 'register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private '
    + 'protected template typename namespace new delete this try catch throw using virtual bool true false null nullptr '
    + 'def lambda import from None True False and or not in is elif pass raise with as global nonlocal yield async await '
    + 'function var let const return').split(' ');
  var KWSET = {};
  KEYWORDS.forEach(function (k) { KWSET[k] = 1; });

  function highlight(code, lang) {
    var out = '', i = 0, L = code.length;
    var isStr = function (c) { return c === '"' || c === "'" || c === '`'; };
    while (i < L) {
      var c = code[i];
      /* 行注释 */
      if (c === '/' && code[i + 1] === '/') {
        var e = code.indexOf('\n', i); if (e < 0) e = L;
        out += '<span class="tk-c">' + esc(code.slice(i, e)) + '</span>'; i = e; continue;
      }
      /* 井号注释（python/shell） */
      if (c === '#') {
        var e2 = code.indexOf('\n', i); if (e2 < 0) e2 = L;
        out += '<span class="tk-c">' + esc(code.slice(i, e2)) + '</span>'; i = e2; continue;
      }
      /* 块注释 */
      if (c === '/' && code[i + 1] === '*') {
        var e3 = code.indexOf('*/', i + 2); e3 = e3 < 0 ? L : e3 + 2;
        out += '<span class="tk-c">' + esc(code.slice(i, e3)) + '</span>'; i = e3; continue;
      }
      /* 字符串 */
      if (isStr(c)) {
        var j = i + 1;
        while (j < L && code[j] !== c) { if (code[j] === '\\') j++; j++; }
        j = Math.min(j + 1, L);
        out += '<span class="tk-s">' + esc(code.slice(i, j)) + '</span>'; i = j; continue;
      }
      /* 数字 */
      if (/[0-9]/.test(c) && !/[A-Za-z_$]/.test(code[i - 1] || '')) {
        var k = i;
        while (k < L && /[0-9a-fA-FxX._]/.test(code[k])) k++;
        out += '<span class="tk-n">' + esc(code.slice(i, k)) + '</span>'; i = k; continue;
      }
      /* 标识符 / 关键字 */
      if (/[A-Za-z_$]/.test(c)) {
        var m = i;
        while (m < L && /[A-Za-z0-9_$]/.test(code[m])) m++;
        var w = code.slice(i, m);
        out += KWSET[w] ? '<span class="tk-k">' + esc(w) + '</span>' : esc(w);
        i = m; continue;
      }
      out += esc(c); i++;
    }
    return out;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 链接白名单：收紧到导航类协议，不放行 data: / blob: */
  function safeUrl(u) {
    u = String(u || '').trim();
    if (/^(https?:|mailto:|#|\/)/i.test(u)) return u;
    return '#';
  }
  /* 图片白名单：只有 <img src> 需要 data:image/ 与 blob: */
  function safeImgUrl(u) {
    u = String(u || '').trim();
    if (/^(https?:|data:image\/|blob:|#|\/)/i.test(u)) return u;
    return '#';
  }

  var R = {
    code: /`([^`\n]+)`/g,
    math: /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g,
    img: /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    link: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    bold: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
    italicStar: /([^_*]|^)\*(?!\*)([^\n*]+?)\*(?!\*)/g,
    italicUnder: /([^_*]|^)_(?!_)([^_\n]+?)_(?!_)/g,
    strike: /~~(?=\S)([\s\S]*?\S)~~/g,
    autolink: /(https?:\/\/[^\s<]+)/g
  };

  /* 行内渲染：先保护 code 与 math，再做其余替换 */
  function inline(text, slots) {
    var s = text;

    s = s.replace(R.code, function (m, c) {
      return SEP + 'C' + slots.push({ kind: 'code', v: c }) + SEP;
    });
    s = s.replace(/\\\$/g, SEP + 'ESC' + SEP);

    s = s.replace(R.math, function (m, b, i2) {
      var code = b != null ? b : i2;
      return SEP + 'M' + slots.push({ kind: 'math', v: code, block: b != null }) + SEP;
    });

    s = esc(s);

    s = s.replace(/\uE000ESC\uE000/g, '&#36;');

    s = s.replace(R.img, function (m, alt, url, title) {
      return '<img class="md-img" src="' + esc(safeImgUrl(url)) + '" alt="' + esc(alt) + '"' +
        (title ? ' title="' + esc(title) + '"' : '') + ' loading="lazy">';
    });
    s = s.replace(R.link, function (m, txt, url, title) {
      return '<a class="md-link" href="' + esc(safeUrl(url)) + '" target="_blank" rel="noopener noreferrer"' +
        (title ? ' title="' + esc(title) + '"' : '') + '>' + txt + '</a>';
    });
    s = s.replace(R.bold, '<strong>$2</strong>');
    s = s.replace(R.strike, '<del>$1</del>');
    s = s.replace(R.italicStar, '$1<em>$2</em>');
    s = s.replace(R.italicUnder, '$1<em>$2</em>');
    s = s.replace(R.autolink, function (m, u) {
      return '<a class="md-link" href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + u + '</a>';
    });
    return s;
  }

  /* 占位符还原 */
  function hydrate(root, slots) {
    if (!slots.length) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [], n;
    while ((n = walker.nextNode())) if (n.nodeValue.indexOf(SEP) >= 0) nodes.push(n);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(SEP), frag = document.createDocumentFragment();
      parts.forEach(function (p) {
        var m = /^([CM])(\d+)$/.exec(p);
        if (m) {
          var slot = slots[parseInt(m[2], 10) - 1];
          if (!slot) return;
          if (slot.kind === 'code') {
            var c = document.createElement('code');
            c.className = 'md-code-inline';
            c.textContent = slot.v;
            frag.appendChild(c);
          } else {
            var span = document.createElement('span');
            span.className = slot.block ? 'tex-block' : 'md-inline-math';
            var h = document.createElement('span');
            h.className = 'tex-holder';
            h.title = slot.v;
            try { h.appendChild(g.TeX.render(slot.v)); }
            catch (e) { h.textContent = '$' + slot.v + '$'; }
            span.appendChild(h);
            frag.appendChild(span);
          }
        } else if (p !== '') {
          frag.appendChild(document.createTextNode(p));
        }
      });
      node.parentNode.replaceChild(frag, node);
    });
  }

  function listItemText(line) {
    return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '');
  }

  function render(src) {
    var slots = [];
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var html = '', i = 0;

    while (i < lines.length) {
      var line = lines[i];

      /* 围栏代码块 */
      var fm = /^\s*```(\w*)\s*$/.exec(line);
      if (fm) {
        var buf = [], lang = fm[1];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        html += '<div class="md-code-block"><div class="md-code-head"><span class="md-code-lang">' +
          esc(lang || 'text') + '</span><button type="button" class="md-copy" data-code="' +
          esc(buf.join('\n')) + '">复制</button></div><pre><code>' +
          highlight(buf.join('\n'), lang) + '</code></pre></div>';
        continue;
      }

      /* 块级公式 $$ ... $$ */
      if (/^\s*\$\$/.test(line)) {
        var tb;
        var rest = line.replace(/^\s*\$\$/, '');
        if (/\$\$\s*$/.test(rest) && rest.replace(/\$\$\s*$/, '').trim()) {
          /* 单行块级公式：$$E=mc^2$$ —— 注意必须推进 i，否则死循环 */
          tb = [rest.replace(/\$\$\s*$/, '')];
          i++;
        } else {
          /* 多行块级公式：起始行 $$，直到遇到以 $$ 结尾的行 */
          var body = rest.trim() ? [rest] : [];
          i++;
          while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
          if (i < lines.length) body.push(lines[i].replace(/\$\$\s*$/, ''));
          i++;
          tb = body;
        }
        html += '<div class="tex-block" data-tex="' + esc(tb.join('\n')) + '"></div>';
        continue;
      }

      /* 空行 */
      if (!line.trim()) { i++; continue; }

      /* 分隔线 */
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { html += '<hr class="md-hr">'; i++; continue; }

      /* 标题 */
      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) { html += '<h' + hm[1].length + ' class="md-h">' + inline(hm[2], slots) + '</h' + hm[1].length + '>'; i++; continue; }

      /* 引用 */
      if (/^\s*>\s?/.test(line)) {
        var qb = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { qb.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote class="md-quote">' + inline(qb.join('\n'), slots) + '</blockquote>';
        continue;
      }

      /* 表格 */
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        var head = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
        i += 2;
        var body = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          body.push(lines[i].replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|')); i++;
        }
        html += '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
          head.map(function (c) { return '<th>' + inline(c.trim(), slots) + '</th>'; }).join('') +
          '</tr></thead><tbody>' +
          body.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + inline(c.trim(), slots) + '</td>'; }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>';
        continue;
      }

      /* 列表 */
      if (/^\s*([-*+]\s+|\d+[.)]\s+)/.test(line)) {
        var ordered = /^\s*\d+[.)]\s+/.test(line);
        var items = [];
        while (i < lines.length && /^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
          var cont = [listItemText(lines[i])]; i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]\s+|\d+[.)]\s+)/.test(lines[i])) {
            cont.push(lines[i].trim()); i++;
          }
          items.push(cont.join('\n'));
        }
        html += '<' + (ordered ? 'ol' : 'ul') + ' class="md-list">' +
          items.map(function (t) { return '<li>' + inline(t, slots) + '</li>'; }).join('') +
          '</' + (ordered ? 'ol' : 'ul') + '>';
        continue;
      }

      /* 普通段落（含软换行） */
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !/^\s*(```|>|#{1,6}\s|[-*+]\s|\d+[.)]\s|\$\$)/.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      html += '<p class="md-p">' + inline(para.join('\n'), slots).replace(/\n/g, '<br>') + '</p>';
    }

    var box = document.createElement('div');
    box.className = 'md';
    box.innerHTML = html;

    /* 块级公式填充 */
    Array.prototype.forEach.call(box.querySelectorAll('.tex-block[data-tex]'), function (b) {
      var h = document.createElement('span');
      h.className = 'tex-holder';
      h.title = b.getAttribute('data-tex');
      try { h.appendChild(g.TeX.render(b.getAttribute('data-tex'))); }
      catch (e) { h.textContent = b.getAttribute('data-tex'); }
      b.appendChild(h);
      b.removeAttribute('data-tex');
    });

    hydrate(box, slots);
    /* 对用户昵称做 @ 高亮：只作用于文本节点，不动标签与属性 */
    atWalk(box);
    return box;
  }

  /* 遍历文本节点，把 @xxx 替换成高亮 span */
  function atWalk(root) {
    var skip = { CODE: 1, PRE: 1, A: 1, SCRIPT: 1, STYLE: 1 };
    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (nd) {
        var pn = nd.parentNode && nd.parentNode.nodeName;
        if (skip[pn]) return NodeFilter.FILTER_REJECT;
        return /@/.test(nd.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var list = [], nd;
    while ((nd = tw.nextNode())) list.push(nd);
    list.forEach(function (t) {
      var frag = document.createDocumentFragment();
      var txt = t.nodeValue, re = /(^|[\s(（\[，,。.；;：:！!？?])@([^\s@]{1,16})/g, last = 0, m;
      while ((m = re.exec(txt))) {
        if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        if (m[1]) frag.appendChild(document.createTextNode(m[1]));   /* 前导字符原样保留 */
        var sp = document.createElement('span');
        sp.className = 'at-mention';
        sp.setAttribute('data-at', m[2]);
        sp.appendChild(document.createTextNode('@' + m[2]));
        frag.appendChild(sp);
        last = m.index + m[0].length;
      }
      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      t.parentNode.replaceChild(frag, t);
    });
  }

  /* 纯文本预览（列表页摘要用） */
  function plain(src) {
    return String(src == null ? '' : src)
      .replace(/```[\s\S]*?```/g, '[代码]')
      .replace(/\$\$([\s\S]+?)\$\$/g, '[公式]')
      .replace(/\$([^$\n]+?)\$/g, '[公式]')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  g.MD = { render: render, plain: plain, esc: esc, safeUrl: safeUrl, safeImgUrl: safeImgUrl };
})(window);
