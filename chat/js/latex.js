/* ------------------------------------------------------------------
 * latex.js —— 自研极简 LaTeX 数学公式渲染器（用 $ 包裹）
 *   $e^{i\pi}+1=0$          行内公式
 *   $$\frac{a}{b}$$         独立公式块
 * 支持：分数 / 根式 / 上下标 / 极限运算符 / 希腊字母 / 矩阵 / cases / 常用符号
 * 不依赖 KaTeX / MathJax，零版权风险，完全离线可用。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var SYM = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
    eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
    upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', div: '÷', cdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙', pm: '±', mp: '∓',
    leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼',
    simeq: '≃', propto: '∝', ll: '≪', gg: '≫', doteq: '≐',
    'in': '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
    cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨', mid: '∣', parallel: '∥',
    to: '→', rightarrow: '→', longrightarrow: '⟶', leftarrow: '←', longleftarrow: '⟵',
    Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', leftrightarrow: '↔', mapsto: '↦',
    uparrow: '↑', downarrow: '↓',
    infty: '∞', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃', bigcap: '⋂',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', dotsc: '…',
    langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
    lVert: '‖', rVert: '‖', vert: '|', prime: '′', deg: '°', angle: '∠', triangle: '△',
    perp: '⊥', therefore: '∴', because: '∵', checkmark: '✓',
    quad: ' ', qquad: ' ', ',': ' ', ':': ' ', ';': ' ', '!': '!', '#': '#', '%': '%',
    backslash: '\\', dollar: '$', ampersand: '&', '_': '_', '{': '{', '}': '}',
    mathbb: null, mathcal: null, mathrm: null
  };

  var OPS_LIMITS = { sum: 1, prod: 1, coprod: 1, int: 1, iint: 1, iiint: 1, oint: 1, bigcup: 1, bigcap: 1, lim: 1, max: 1, min: 1, sup: 1, inf: 1, argmax: 1, argmin: 1 };
  var FUNC_NAMES = { sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1, arcsin: 1, arccos: 1, arctan: 1, sinh: 1, cosh: 1, tanh: 1, exp: 1, log: 1, ln: 1, lg: 1, det: 1, dim: 1, ker: 1, gcd: 1, lcm: 1, Pr: 1, mod: 1, deg: 1, arg: 1 };

  /* ---------------- 词法分析 ---------------- */
  function tokenize(src) {
    var out = [], i = 0, n = src.length;
    while (i < n) {
      var c = src[i];
      if (c === '\\') {
        if (src[i + 1] === '\\') { out.push({ t: 'nl' }); i += 2; continue; }
        var j = i + 1, name = '';
        while (j < n && /[A-Za-z]/.test(src[j])) { name += src[j]; j++; }
        if (!name) { out.push({ t: 'char', v: src[j] || '' }); i = j + 1; continue; }
        out.push({ t: 'cmd', v: name });
        i = j;
        if (src[i] === ' ') i++;
        continue;
      }
      if (c === '{') { out.push({ t: 'open' }); i++; continue; }
      if (c === '}') { out.push({ t: 'close' }); i++; continue; }
      if (c === '^') { out.push({ t: 'sup' }); i++; continue; }
      if (c === '_') { out.push({ t: 'sub' }); i++; continue; }
      if (c === '&') { out.push({ t: 'amp' }); i++; continue; }
      out.push({ t: 'char', v: c }); i++;
    }
    return out;
  }

  function el(cls, txt) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    if (txt != null) s.textContent = txt;
    return s;
  }

  /* 取一个参数：{...} 或单个字符 / 单条命令（含其参数） */
  function parseArg(tk, i) {
    if (i >= tk.length) return { el: el(''), i: i };
    if (tk[i].t === 'open') return parseGroup(tk, i + 1);
    if (tk[i].t === 'cmd') return parseCmd(tk, i);
    var e = el('');
    e.appendChild(renderChar(tk[i].v));
    return { el: e, i: i + 1 };
  }

  function renderChar(ch) {
    var map = { '-': '−', '*': '∗', '=': '=', '+': '+', '<': '<', '>': '>', '/': '/' };
    if (map[ch] && ch === '-') ch = '−';
    var s = el();
    s.textContent = ch;
    return s;
  }

  /* ---------------- 结构命令 ---------------- */
  function parseCmd(tk, i) {
    var name = tk[i].v, next = i + 1;

    if (SYM[name] !== undefined && SYM[name] !== null) {
      var symStr = SYM[name];
      if (OPS_LIMITS[name]) return { el: makeLimits(symStr), i: next };
      var s = el('tex-op');
      s.textContent = symStr;
      return { el: s, i: next };
    }
    if (FUNC_NAMES[name]) { var f = el('tex-fn'); f.textContent = name; return { el: f, i: next }; }

    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac': {
        var a = parseArg(tk, next), b = parseArg(tk, a.i);
        var w = el('tex-frac');
        var num = el('tex-num'); num.appendChild(a.el);
        var den = el('tex-den'); den.appendChild(b.el);
        w.appendChild(num); w.appendChild(den);
        return { el: w, i: b.i };
      }
      case 'binom': {
        var A = parseArg(tk, next), B = parseArg(tk, A.i);
        var bw = el('tex-paren');
        var bf = el('tex-frac'); var bn = el('tex-num'); bn.appendChild(A.el); var bd = el('tex-den'); bd.appendChild(B.el);
        bf.appendChild(bn); bf.appendChild(bd);
        bw.appendChild(el('tex-big', '(')); bw.appendChild(bf); bw.appendChild(el('tex-big', ')'));
        return { el: bw, i: B.i };
      }
      case 'sqrt': {
        var idx = null, p = next;
        if (tk[p] && tk[p].t === 'char' && tk[p].v === '[') {
          var body = '', q = p + 1;
          while (q < tk.length && !(tk[q].t === 'char' && tk[q].v === ']')) { body += tk[q].v || ''; q++; }
          idx = body; p = q + 1;
        }
        var r = parseArg(tk, p), w2 = el('tex-sqrt');
        if (idx) { var ix = el('tex-sqrt-idx'); ix.textContent = idx; w2.appendChild(ix); }
        w2.appendChild(el('tex-sqrt-sign', '√'));
        var bd2 = el('tex-sqrt-body'); bd2.appendChild(r.el);
        w2.appendChild(bd2);
        return { el: w2, i: r.i };
      }
      case 'overline': case 'underline': case 'hat': case 'widehat': case 'bar':
      case 'vec': case 'tilde': case 'dot': case 'ddot': case 'check': case 'breve': {
        var ar = parseArg(tk, next), acc = el('tex-' + name);
        acc.appendChild(ar.el);
        return { el: acc, i: ar.i };
      }
      case 'text': case 'textrm': case 'mathrm': case 'textbf': case 'mathit': case 'mbox': {
        if (tk[next] && tk[next].t === 'open') {
          var raw = '', depth = 0, k = next;
          for (; k < tk.length; k++) {
            if (tk[k].t === 'open') depth++;
            else if (tk[k].t === 'close') { depth--; if (!depth) break; }
            else if (depth === 1) raw += (tk[k].v || '');
          }
          var t = el(name === 'textbf' ? 'tex-bold' : (name === 'mathit' ? 'tex-it' : 'tex-rm'));
          t.textContent = raw;
          return { el: t, i: k + 1 };
        }
        return { el: el(''), i: next };
      }
      case 'operatorname': {
        var oa = parseArg(tk, next), on = el('tex-fn');
        on.textContent = (oa.el.textContent || '').trim();
        return { el: on, i: oa.i };
      }
      case 'left': case 'right': {
        if (tk[next]) {
          var d = tk[next].v === '.' ? '' : (tk[next].v || '');
          var dd = el('tex-delim', d);
          return { el: dd, i: next + 1 };
        }
        return { el: el(''), i: next };
      }
      case 'begin': {
        var envName = '', m = next;
        if (tk[m] && tk[m].t === 'open') {
          m++;
          while (m < tk.length && tk[m].t !== 'close') { envName += tk[m].v || ''; m++; }
          m++;
        }
        return parseEnv(tk, m, envName);
      }
      case 'hspace': case 'vspace': case 'kern': { var pa = parseArg(tk, next); return { el: el(''), i: pa.i }; }
      case 'limits': case 'nolimits': case 'displaystyle': case 'textstyle': case 'scriptstyle':
        return { el: el(''), i: next };
      case 'color': { var ca = parseArg(tk, next); var rest = parseGroup(tk, ca.i); return { el: rest.el, i: rest.i }; }
      default: {
        var unknown = el('tex-rm');
        unknown.textContent = name;
        return { el: unknown, i: next };
      }
    }
  }

  function makeLimits(sym) {
    var wrap = el('tex-limits');
    wrap.appendChild(el('lim-up'));
    var mid = el('lim-mid'); var op = el('tex-op'); op.textContent = sym; mid.appendChild(op);
    wrap.appendChild(mid);
    wrap.appendChild(el('lim-dn'));
    return wrap;
  }

  /* 矩阵 / cases / aligned 环境 */
  function parseEnv(tk, i, env) {
    var rows = [], cur = [], depth = 0;
    while (i < tk.length) {
      var t = tk[i];
      if (t.t === 'cmd' && (t.v === 'end')) {
        while (i < tk.length && tk[i].t !== 'close') i++;
        i++; break;
      }
      if (t.t === 'open') depth++;
      if (t.t === 'close') depth--;
      /* & 分列（同一行内继续），\\ 才换行 */
      if (t.t === 'amp') { i++; continue; }
      if (t.t === 'nl') { rows.push(cur); cur = []; i++; continue; }
      var piece = document.createElement('span');
      var sub = parseGroup(tk, i, true);
      piece.appendChild(sub.el);
      cur.push(piece);
      /* 防御：若子解析没有推进下标（畸形输入），强制前进一格，避免死循环 */
      i = sub.i > i ? sub.i : i + 1;
    }
    if (cur.length) rows.push(cur);

    if (env === 'cases' || env === 'dcases' || env === 'aligned' || env === 'align' || env === 'align*' ||
      env === 'gathered' || env === 'split') {
      var box = el('tex-env tex-' + env);
      rows.forEach(function (r) {
        var line = el('env-row');
        r.forEach(function (cell, ci) {
          var c = el('env-cell'); c.appendChild(cell);
          line.appendChild(c);
          if (env === 'cases' && ci === 0) { /* 条件列 */ }
        });
        box.appendChild(line);
      });
      if (env === 'cases') { var br = el('tex-delim cases-brace'); br.textContent = '{'; box.insertBefore(br, box.firstChild); }
      return { el: box, i: i };
    }

    var ncols = 0;
    rows.forEach(function (r) { if (r.length > ncols) ncols = r.length; });
    var grid = el('tex-matrix');
    grid.style.gridTemplateColumns = 'repeat(' + ncols + ', auto)';
    rows.forEach(function (r) {
      for (var c = 0; c < ncols; c++) {
        var cell = el('mcell');
        if (r[c]) cell.appendChild(r[c]);
        grid.appendChild(cell);
      }
    });
    var outer = el('tex-matrix-wrap');
    if (env === 'pmatrix') { outer.appendChild(el('tex-delim', '(')); }
    else if (env === 'bmatrix') { outer.appendChild(el('tex-delim', '[')); }
    else if (env === 'Bmatrix') { outer.appendChild(el('tex-delim', '{')); }
    else if (env === 'vmatrix') { outer.appendChild(el('tex-delim', '|')); }
    else if (env === 'Vmatrix') { outer.appendChild(el('tex-delim', '‖')); }
    outer.appendChild(grid);
    if (env === 'pmatrix') { outer.appendChild(el('tex-delim', ')')); }
    else if (env === 'bmatrix') { outer.appendChild(el('tex-delim', ']')); }
    else if (env === 'Bmatrix') { outer.appendChild(el('tex-delim', '}')); }
    else if (env === 'vmatrix') { outer.appendChild(el('tex-delim', '|')); }
    else if (env === 'Vmatrix') { outer.appendChild(el('tex-delim', '‖')); }
    return { el: outer, i: i };
  }

  /* ---------------- 语法分析 ---------------- */
  function parseGroup(tk, i, stopAtEnd) {
    var box = el('tex');
    while (i < tk.length) {
      var t = tk[i];
      if (t.t === 'close') return { el: box, i: i + 1 };
      if (t.t === 'amp' || t.t === 'nl') return { el: box, i: i };
      if (t.t === 'open') { var sub = parseGroup(tk, i + 1); box.appendChild(sub.el); i = sub.i; continue; }
      /* 环境/分组结束符：交给上层处理，不在本层消费，否则 \end 会被当成普通命令渲染 */
      if (t.t === 'cmd' && stopAtEnd && (t.v === 'end' || t.v === 'right')) return { el: box, i: i };
      if (t.t === 'cmd') { var r = parseCmd(tk, i); box.appendChild(r.el); i = r.i; continue; }
      if (t.t === 'sup' || t.t === 'sub') {
        var isSup = t.t === 'sup';
        var arg = parseArg(tk, i + 1);
        var last = box.lastElementChild;
        if (last && last.classList && last.classList.contains('tex-limits')) {
          var slot = last.querySelector(isSup ? '.lim-up' : '.lim-dn');
          if (slot) slot.appendChild(arg.el);
        } else {
          var wrap = el(isSup ? 'tex-sup' : 'tex-sub');
          var base = last || el('');
          if (!last) box.appendChild(base);
          else box.removeChild(last);
          var holder = el('tex-scripts');
          holder.appendChild(base);
          var sc = el(isSup ? 'sup-box' : 'sub-box'); sc.appendChild(arg.el);
          holder.appendChild(sc);
          box.appendChild(holder);
        }
        i = arg.i;
        continue;
      }
      box.appendChild(renderChar(t.v));
      i++;
    }
    return { el: box, i: i };
  }

  function render(src) {
    var tk = tokenize(src);
    var r = parseGroup(tk, 0);
    return r.el;
  }

  /* 对外：$...$ 行内，$$...$$ 块级 */
  function renderInline(text) {
    var frag = document.createDocumentFragment();
    var re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var code = m[1] != null ? m[1] : m[2];
      var wrap = el(m[1] != null ? 'tex-block' : 'tex-inline');
      var holder = document.createElement('span');
      holder.className = 'tex-holder';
      holder.title = code;
      try { holder.appendChild(render(code)); }
      catch (e) { holder.textContent = '$' + code + '$'; holder.className = 'tex-holder tex-error'; }
      wrap.appendChild(holder);
      frag.appendChild(wrap);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  /* 整段文本中把 $$...$$ 抽成块级公式（供 Markdown 使用） */
  function extractBlocks(lines) {
    var out = [], buf = null;
    lines.forEach(function (line) {
      if (/^\s*\$\$/.test(line) && !/\$\$\s*$/.test(line.slice(2))) {
        buf = [line.replace(/^\s*\$\$/, '')];
        return;
      }
      if (buf) {
        if (/\$\$\s*$/.test(line)) { buf.push(line.replace(/\$\$\s*$/, '')); out.push({ type: 'blocktex', code: buf.join('\n') }); buf = null; }
        else buf.push(line);
        return;
      }
      if (/^\s*\$\$(.+)\$\$\s*$/.test(line)) { out.push({ type: 'blocktex', code: RegExp.$1 }); return; }
      out.push({ type: 'line', text: line });
    });
    if (buf) out.push({ type: 'blocktex', code: buf.join('\n') });
    return out;
  }

  g.TeX = { render: render, renderInline: renderInline, extractBlocks: extractBlocks };
})(window);
