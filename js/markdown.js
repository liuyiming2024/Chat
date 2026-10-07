/* ------------------------------------------------------------------
 * markdown.js —— 自研轻量 Markdown 渲染器（GFM 子集）
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块 / 引用 /
 *       有序无序列表 / 表格 / 链接 / 图片 / 分隔线 / $LaTeX$ / $$块公式$$
 * 全部内容先转义再渲染，URL 走协议白名单，杜绝 XSS。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var SEP = '\uE000';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    u = String(u || '').trim();
    if (/^(https?:|mailto:|data:image\/|blob:|#|\/)/i.test(u)) return u;
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
      return '<img class="md-img" src="' + esc(safeUrl(url)) + '" alt="' + esc(alt) + '"' +
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
          esc(buf.join('\n')) + '">复制</button></div><pre><code>' + esc(buf.join('\n')) + '</code></pre></div>';
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
    return box;
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

  g.MD = { render: render, plain: plain, esc: esc, safeUrl: safeUrl };
})(window);
