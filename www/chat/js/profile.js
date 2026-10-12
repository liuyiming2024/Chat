/* ------------------------------------------------------------------
 * profile.js —— 人物档案（站长专用）
 *
 * 定位：
 *   对【一个人】的档案。页内随手丢关于他的零散信息（含图片），
 *   定期交 AI 整理成 时间线 / 分类条目 / 结构化摘要，
 *   整理结果**保留历史**（每次一版，不覆盖）。
 *
 * ⚠ 三条硬约束（用户明确要求，别改）：
 *   1. **不加密，只鉴权**。用户 2026-10-12 定了"无密钥，只鉴权"——
 *      服务端存明文，但只有站长能读。
 *      这不是疏漏：加密会与"交给 AI 整理"直接冲突
 *      （加密后服务端是密文，AI 拿不到明文，整理就只剩排版）。
 *   2. **显示前先鉴权**。先问服务端能不能看，不能看就什么都不渲染。
 *      不能"先渲染再隐藏"—— 那样数据已经到了客户端。
 *   3. **不在其他项目露出**。入口只是一个小按钮，且非站长看不见。
 *
 * 整理闭环（三种触发都要）：
 *   · 手动「整理」按钮 → 导出待整理文本
 *   · 攒够 N 条自动提示
 *   · 定时委托（由用户在外面设置）
 *   导出的文本交给 AI 整理后，粘回本页保存成新的一版历史。
 * ------------------------------------------------------------------ */
(function (g) {
  'use strict';

  var AUTO_HINT_AT = 20;        /* 攒够多少条就提示该整理了 */
  var cur = null;               /* 当前档案 id */
  var list = [];
  var detail = null;

  function rpc(name, args) {
    return g.SB.rpc(name, args || {});
  }

  /* ⚠ 鉴权必须在取数之前。
     这个函数是唯一的入口 —— 任何渲染都必须先经过它。
     失败就抛，调用方 catch 后提示，不渲染任何内容。 */
  function ensureAllowed() {
    return rpc('profile_list').then(function (r) {
      list = r || [];
      return true;
    });
  }

  function openProfile() {
    /* 先鉴权，再渲染。没权限就到此为止 ——
       连空面板都不弹，避免"弹出来了但空的"这种困惑。 */
    return ensureAllowed().then(function () {
      render();
    }).catch(function (e) {
      g.UI.toast('无法打开档案：' + (e && e.message ? e.message : '没有权限'), 'err', 5000);
      throw e;
    });
  }

  function render() {
    var d = document.createElement('div');
    d.style.cssText = 'display:flex;gap:12px;min-height:420px;';

    /* ---- 左：人物列表 ---- */
    var left = document.createElement('div');
    left.style.cssText = 'width:180px;flex:none;border-right:1px solid #ddd;padding-right:10px;';
    left.innerHTML = '<div style="font-weight:600;margin-bottom:8px;">人物</div>';
    var ul = document.createElement('div');
    list.forEach(function (p) {
      var it = document.createElement('div');
      it.className = 'profile-person' + (p.id === cur ? ' on' : '');
      it.style.cssText = 'padding:6px 8px;cursor:pointer;border-radius:4px;font-size:13px;';
      it.textContent = p.name + '（' + (p.entry_count || 0) + '）';
      it.onclick = function () { loadDetail(p.id); };
      ul.appendChild(it);
    });
    left.appendChild(ul);
    var addBtn = document.createElement('button');
    addBtn.className = 'btn ghost';
    addBtn.style.cssText = 'margin-top:10px;width:100%;font-size:12px;';
    addBtn.textContent = '+ 新建人物';
    addBtn.onclick = function () {
      var n = prompt('人物名');
      if (!n || !n.trim()) return;
      rpc('profile_create', { p_name: n.trim() }).then(function () {
        return ensureAllowed();
      }).then(function () { render(); });
    };
    left.appendChild(addBtn);
    d.appendChild(left);

    /* ---- 右：详情 ---- */
    var right = document.createElement('div');
    right.style.cssText = 'flex:1;min-width:0;';
    if (!cur) {
      right.innerHTML = '<div style="color:#888;font-size:13px;padding:20px 0;">'
        + '从左边选一个人物，或新建一个。</div>';
    } else {
      right.appendChild(renderDetail());
    }
    d.appendChild(right);

    g.UI.modal({
      title: '人物档案（仅站长）',
      body: d,
      wide: true,
      okText: null,
      cancelText: '关闭'
    });
  }

  function renderDetail() {
    var wrap = document.createElement('div');
    if (!detail) {
      wrap.innerHTML = '<div style="color:#888;">加载中…</div>';
      return wrap;
    }
    var p = detail.profile || {};
    var entries = detail.entries || [];
    var sums = detail.summaries || [];

    /* ---- 输入区 ---- */
    var box = document.createElement('div');
    box.style.cssText = 'margin-bottom:12px;';
    var ta = document.createElement('textarea');
    ta.className = 'field';
    ta.placeholder = '随手记：关于这个人，今天知道了什么…';
    ta.style.cssText = 'width:100%;height:60px;resize:vertical;';
    box.appendChild(ta);

    var row = document.createElement('div');
    row.style.cssText = 'margin-top:6px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

    var imgPaths = [];
    var fileBtn = document.createElement('button');
    fileBtn.className = 'btn ghost';
    fileBtn.style.fontSize = '12px';
    fileBtn.textContent = '＋ 图片';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.onchange = function () {
      Array.prototype.forEach.call(fileInput.files || [], function (f) {
        uploadImage(f).then(function (path) {
          imgPaths.push(path);
          thumbWrap.appendChild(mkThumb(path));
        }).catch(function (e) {
          g.UI.toast('图片上传失败：' + (e && e.message ? e.message : '网络错误'), 'err');
        });
      });
      fileInput.value = '';
    };
    fileBtn.onclick = function () { fileInput.click(); };

    var thumbWrap = document.createElement('span');
    thumbWrap.style.cssText = 'display:inline-flex;gap:4px;flex-wrap:wrap;';

    var sendBtn = document.createElement('button');
    sendBtn.className = 'btn';
    sendBtn.style.fontSize = '12px';
    sendBtn.textContent = '记下';
    sendBtn.onclick = function () {
      var body = ta.value || '';
      if (!body.trim() && !imgPaths.length) { g.UI.toast('写点什么，或加张图', 'err'); return; }
      rpc('profile_entry_add', {
        p_profile: cur, p_body: body, p_images: imgPaths
      }).then(function () {
        ta.value = ''; imgPaths = []; thumbWrap.innerHTML = '';
        return loadDetail(cur, true);
      }).catch(function (e) {
        g.UI.toast('保存失败：' + (e && e.message ? e.message : '网络错误'), 'err');
      });
    };

    row.appendChild(fileBtn);
    row.appendChild(thumbWrap);
    row.appendChild(sendBtn);
    box.appendChild(row);
    wrap.appendChild(box);

    /* ---- 攒够提示 ---- */
    if (entries.length >= AUTO_HINT_AT) {
      var hint = document.createElement('div');
      hint.style.cssText = 'background:#fff8e1;border-left:3px solid #f0ad4e;'
        + 'padding:8px 10px;font-size:12px;margin-bottom:12px;';
      hint.textContent = '已经攒了 ' + entries.length + ' 条，可以整理一次了。';
      wrap.appendChild(hint);
    }

    /* ---- 整理 ---- */
    var tabWrap = document.createElement('div');
    tabWrap.style.cssText = 'margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

    var exportBtn = document.createElement('button');
    exportBtn.className = 'btn ghost';
    exportBtn.style.fontSize = '12px';
    exportBtn.textContent = '导出待整理文本';
    exportBtn.onclick = function () { exportForAI(entries, p); };
    tabWrap.appendChild(exportBtn);

    var pasteBtn = document.createElement('button');
    pasteBtn.className = 'btn ghost';
    pasteBtn.style.fontSize = '12px';
    pasteBtn.textContent = '粘贴整理结果';
    pasteBtn.onclick = function () { pasteResult(); };
    tabWrap.appendChild(pasteBtn);

    var histBtn = document.createElement('button');
    histBtn.className = 'btn ghost';
    histBtn.style.fontSize = '12px';
    histBtn.textContent = '历史版本';
    histBtn.onclick = function () { showHistory(); };
    tabWrap.appendChild(histBtn);
    wrap.appendChild(tabWrap);

    ['timeline', 'category', 'digest'].forEach(function (kind) {
      var s = sums.filter(function (x) { return x.kind === kind; })[0];
      var label = { timeline: '时间线', category: '分类条目', digest: '结构化摘要' }[kind];
      var sec = document.createElement('div');
      sec.style.cssText = 'margin-bottom:10px;';
      sec.innerHTML = '<div style="font-weight:600;font-size:13px;margin-bottom:4px;">'
        + label + (s ? '<span style="font-weight:400;color:#888;font-size:11px;"> · '
          + new Date(s.created_at).toLocaleString() + '</span>' : '') + '</div>';
      var body = document.createElement('div');
      body.style.cssText = 'white-space:pre-wrap;font-size:13px;background:#f7f7f7;'
        + 'padding:8px 10px;border-radius:4px;';
      body.textContent = s ? s.content : '（还没整理过）';
      sec.appendChild(body);
      wrap.appendChild(sec);
    });

    /* ---- 条目列表 ---- */
    var el = document.createElement('div');
    el.style.cssText = 'font-weight:600;font-size:13px;margin:14px 0 6px;';
    el.textContent = '零散条目（' + entries.length + '）';
    wrap.appendChild(el);

    entries.forEach(function (e2) {
      var it = document.createElement('div');
      it.style.cssText = 'border-bottom:1px solid #eee;padding:6px 0;font-size:13px;';
      var meta = document.createElement('div');
      meta.style.cssText = 'color:#888;font-size:11px;margin-bottom:2px;';
      meta.textContent = new Date(e2.created_at).toLocaleString();
      it.appendChild(meta);
      if (e2.body) {
        var bd = document.createElement('div');
        bd.style.whiteSpace = 'pre-wrap';
        bd.textContent = e2.body;
        it.appendChild(bd);
      }
      if (e2.images && e2.images.length) {
        var iw = document.createElement('div');
        iw.style.cssText = 'display:flex;gap:4px;margin-top:4px;flex-wrap:wrap;';
        e2.images.forEach(function (pp) { iw.appendChild(mkThumb(pp)); });
        it.appendChild(iw);
      }
      var del = document.createElement('span');
      del.textContent = '删除';
      del.style.cssText = 'color:#c00;font-size:11px;cursor:pointer;margin-left:6px;';
      del.onclick = function () {
        rpc('profile_entry_del', { p_id: e2.id }).then(function () {
          return loadDetail(cur, true);
        });
      };
      meta.appendChild(del);
      wrap.appendChild(it);
    });

    return wrap;
  }

  function mkThumb(path) {
    var im = document.createElement('img');
    im.src = g.SB.mediaUrl ? g.SB.mediaUrl(path) : path;
    im.style.cssText = 'width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #ddd;';
    im.onclick = function () { if (g.UI.showImage) g.UI.showImage(im.src); };
    return im;
  }

  function uploadImage(file) {
    return rpc('profile_media_prepare', { p_name: file.name, p_size: file.size })
      .then(function (r) {
        var path = r.path || (r && r.data && r.data.path);
        return g.SB.uploadToStorage('profiles', path, file).then(function () {
          return rpc('profile_media_commit', { p_path: path });
        }).then(function () { return path; });
      });
  }

  /* 导出成适合交给 AI 的纯文本 */
  function exportForAI(entries, p) {
    var lines = ['# 人物档案：' + (p.name || ''), ''];
    if (p.note) lines.push('备注：' + p.note, '');
    lines.push('共 ' + entries.length + ' 条零散记录，按时间倒序：', '');
    entries.slice().reverse().forEach(function (e2, i) {
      var t = new Date(e2.created_at).toLocaleString();
      lines.push((i + 1) + '. [' + t + '] ' + (e2.body || ''));
      if (e2.images && e2.images.length) {
        lines.push('   （附图 ' + e2.images.length + ' 张）');
      }
    });
    var txt = lines.join('\n');
    g.UI.modal({
      title: '复制这段交给 AI 整理',
      body: (function () {
        var d2 = document.createElement('div');
        var ta2 = document.createElement('textarea');
        ta2.className = 'field';
        ta2.style.cssText = 'width:100%;height:280px;font-size:12px;';
        ta2.value = txt;
        d2.appendChild(ta2);
        var cb = document.createElement('button');
        cb.className = 'btn ghost';
        cb.style.cssText = 'margin-top:8px;font-size:12px;';
        cb.textContent = '复制到剪贴板';
        cb.onclick = function () {
          ta2.select();
          try { document.execCommand('copy'); g.UI.toast('已复制', 'ok'); }
          catch (e) { g.UI.toast('复制失败，请手动选中', 'err'); }
        };
        d2.appendChild(cb);
        return d2;
      })(),
      wide: true, okText: null, cancelText: '关闭'
    });
  }

  /* 把 AI 整理好的结果存成新的一版（不覆盖旧的） */
  function pasteResult() {
    var d2 = document.createElement('div');
    d2.innerHTML = '<div class="field-hint" style="margin-bottom:6px;">'
      + '选形态，把 AI 整理好的内容粘进来。<b>每次保存都是新的一版，不会覆盖旧的。</b></div>';
    var sel = document.createElement('select');
    sel.className = 'field';
    sel.style.cssText = 'margin-bottom:6px;';
    [['timeline', '时间线'], ['category', '分类条目'], ['digest', '结构化摘要']]
      .forEach(function (o) {
        var op = document.createElement('option');
        op.value = o[0]; op.textContent = o[1];
        sel.appendChild(op);
      });
    d2.appendChild(sel);
    var ta2 = document.createElement('textarea');
    ta2.className = 'field';
    ta2.style.cssText = 'width:100%;height:200px;font-size:13px;';
    ta2.placeholder = '把整理结果粘在这里…';
    d2.appendChild(ta2);

    g.UI.modal({
      title: '保存整理结果',
      body: d2,
      wide: true,
      okText: '保存为新的一版',
      onOk: function () {
        var c = ta2.value || '';
        if (!c.trim()) { g.UI.toast('内容是空的', 'err'); return false; }
        rpc('profile_summary_add', {
          p_profile: cur, p_kind: sel.value, p_content: c
        }).then(function () {
          g.UI.toast('已保存为新的一版', 'ok');
          loadDetail(cur, true);
        }).catch(function (e) {
          g.UI.toast('保存失败：' + (e && e.message ? e.message : '网络错误'), 'err');
        });
      }
    });
  }

  function showHistory() {
    var kind = prompt('看哪种形态的历史？timeline / category / digest', 'timeline');
    if (!kind) return;
    rpc('profile_summary_history', { p_profile: cur, p_kind: kind }).then(function (r) {
      var h = r || [];
      if (!h.length) { g.UI.toast('还没有这个形态的历史', 'err'); return; }
      var d2 = document.createElement('div');
      d2.style.cssText = 'max-height:400px;overflow:auto;';
      h.forEach(function (x, i) {
        var b = document.createElement('div');
        b.style.cssText = 'margin-bottom:10px;';
        var t = document.createElement('div');
        t.style.cssText = 'font-size:11px;color:#888;';
        t.textContent = '第 ' + (h.length - i) + ' 版 · ' + new Date(x.created_at).toLocaleString();
        var c = document.createElement('div');
        c.style.cssText = 'white-space:pre-wrap;font-size:13px;background:#f7f7f7;padding:8px;border-radius:4px;';
        c.textContent = x.content;
        b.appendChild(t); b.appendChild(c);
        d2.appendChild(b);
      });
      g.UI.modal({
        title: '整理历史（' + kind + '）', body: d2, wide: true,
        okText: null, cancelText: '关闭'
      });
    });
  }

  function loadDetail(id, keepModal) {
    cur = id;
    return rpc('profile_get', { p_id: id }).then(function (r) {
      detail = r;
      if (keepModal) {
        /* 刷新当前面板内容：直接重开一次（幂等，不会叠加） */
        render();
      } else {
        render();
      }
    }).catch(function (e) {
      g.UI.toast('读取失败：' + (e && e.message ? e.message : '网络错误'), 'err');
    });
  }

  g.Profile = { open: openProfile };
})(window);
