"""通过 Obsidian 官方 CLI 验证已安装插件；仅创建合成笔记，结束后移入回收站。"""
import json
import pathlib
import subprocess
import sys
import uuid

PREFIX = '_AXL_Audit_' + uuid.uuid4().hex[:8]
PLUGIN = 'axl-light-zh'


def evaluate(code):
    result = subprocess.check_output(['obsidian', 'eval', 'code=' + code], text=True)
    if 'Error:' in result or '=> ' not in result:
        raise RuntimeError(result)
    value = result.split('=> ', 1)[1].strip()
    return json.loads(value)


def pdf_bytes():
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>',
               b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    stream = b'BT /F1 18 Tf 60 720 Td (PDF annotation verification text) Tj ET'
    objects.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
    result = b'%PDF-1.4\n'
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(result))
        result += f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n'
    xref = len(result)
    result += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
    result += b''.join(f'{offset:010d} 00000 n \n'.encode() for offset in offsets[1:])
    return result + f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF'.encode()


helpers = """
const assert = (condition,message) => {if(!condition)throw Error(message);};
const wait = async (predicate,message) => {for(let i=0;i<160;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw Error(message);};
const plugin = () => app.plugins.plugins['axl-light-zh'];
const select = (root,text,occurrence=0) => {
  const doc=root.ownerDocument, walker=doc.createTreeWalker(root,4), nodes=[];let node;
  while(node=walker.nextNode())if(!node.parentElement.closest('button,svg,.mod-header,.mod-footer,.callout-title'))nodes.push(node);
  const content=nodes.map(n=>n.data).join('');let at=-1;
  for(let i=0;i<=occurrence;i++)at=content.indexOf(text,at+1);
  assert(at>=0,'找不到测试选区：'+text);
  const range=doc.createRange();let offset=0,started=false;
  for(const n of nodes){if(!started && at<offset+n.length){range.setStart(n,at-offset);started=true;}if(started && at+text.length<=offset+n.length){range.setEnd(n,at+text.length-offset);break;}offset+=n.length;}
  const selection=doc.getSelection();selection.removeAllRanges();selection.addRange(range);
  doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
  return selection;
};
"""
result = {}
try:
    source = '# 标题定位\n\n阅读创建测试，视频模型。视频模型。\n\n中文引号”**强调短语：**后面的正文。\n\n重复段落文字。\n\n重复段落文字。\n\n含公式 $x^2$ 的邻近文字。\n\n脚注附近文字[^n]。\n\n带块ID的文字。 ^audit-block\n\n行内代码 `const x = 1` 与 [链接文字](https://example.invalid)。\n\n- [ ] 任务项目测试\n\n> 引用便签测试\n\n| 字段 | 内容 |\n| --- | --- |\n| 名称 | 视频模型 |\n| 真正标注 | 表格测试 |\n\n[^n]: 注脚说明。\n'
    setup = f"""(async()=>{{{helpers}
      const original=app.workspace.getMostRecentLeaf();
      assert(plugin() && plugin().commentModals.size===0,'请先启用插件并完成尚未关闭的便签编辑');
      assert(!window.__axlAudit,'上次验收尚未清理');
      window.__axlAudit={{original,leaf:null,files:[],prefix:{json.dumps(PREFIX)},ids:[],results:[]}};
      const file=await app.vault.create({json.dumps(PREFIX+'.md')},{json.dumps(source)});
      window.__axlAudit.files.push(file);
      const other=await app.vault.create({json.dumps(PREFIX+'_other.md')},'独立文档写入验收');
      window.__axlAudit.files.push(other);
      const pdf=await app.vault.createBinary({json.dumps(PREFIX+'.pdf')},new Uint8Array({json.dumps(list(pdf_bytes()))}).buffer);
      window.__axlAudit.files.push(pdf);
      const leaf=app.workspace.getLeaf('tab');await leaf.openFile(file);
      window.__axlAudit.leaf=leaf;
      await leaf.setViewState({{type:'markdown',state:{{file:file.path,mode:'preview'}}}});
      await wait(()=>leaf.view.previewMode?.containerEl.querySelector('table'),'阅读表格未渲染');
      return JSON.stringify({{fixture:file.path}});
    }})()"""
    result['setup'] = evaluate(setup)
    markdown = f"""(async()=>{{{helpers}
      const s=window.__axlAudit,leaf=s.leaf,file=s.files[0];let view=leaf.view;
      const paintCount=()=>view.previewMode.containerEl.querySelectorAll('.axl-reading-highlight').length;
      const cases=[['h1','标题定位'],['.el-p','阅读创建测试'],['.el-p','强调短语：'],['.el-p','邻近文字'],['.el-p','脚注附近文字'],['.el-p','带块ID的文字'],['.el-p','const x = 1'],['.el-p','链接文字'],['.el-ul','任务项目测试'],['.el-blockquote','引用便签测试'],['table','表格测试']];
      for(const [selector,text]of cases){{
        const root=[...view.previewMode.containerEl.querySelectorAll(selector)].find(e=>e.textContent.includes(text));assert(root,'缺少块 '+text);
        select(root,text);const before=(await plugin().store.getDocument(file)).highlights.length;
        const snapshot=await plugin().resolveSelection(root.ownerDocument,false);assert(snapshot?.selectedText===text,'阅读模式选区解析失败 '+text);
        const toolbar=plugin().surface(root.ownerDocument).toolbar;toolbar.showForSelection();
        const button=root.ownerDocument.querySelector('.axl-selection-toolbar [data-axl-color="green"]');
        const event=new root.ownerDocument.defaultView.MouseEvent('mousedown',{{bubbles:true,cancelable:true}});assert(!button.dispatchEvent(event),'工具条未保护选区');button.click();
        await wait(()=>plugin().store.getCachedDocument(file.path).highlights.length===before+1,'工具条未创建 '+text);
        await wait(()=>[...view.previewMode.containerEl.querySelectorAll('.axl-reading-highlight')].some(e=>e.textContent===text),'创建后阅读高亮不可见 '+text);
        s.results.push('阅读工具条创建并显示：'+text);
      }}
      assert(![...view.previewMode.containerEl.querySelectorAll('td')].find(e=>e.textContent==='视频模型').querySelector('.axl-reading-highlight'),'表格同词误高亮');
      const repeated=[...view.previewMode.containerEl.querySelectorAll('.el-p')].filter(e=>e.textContent==='重复段落文字。');assert(repeated.length===2,'重复段落未渲染');
      select(repeated[1],'重复段落文字');await plugin().createHighlight('purple',document);
      await wait(()=>view.previewMode.containerEl.querySelectorAll('.axl-highlight--purple').length===1,'重复块未显示');
      assert(!view.previewMode.containerEl.querySelectorAll('.el-p')[0].querySelector('.axl-highlight--purple'),'重复块串标');
      s.results.push('重复完整段落仅标第二处');
      // 真实模态框路径：取消不得保存，提交后才能出现便签。
      const quote=view.previewMode.containerEl.querySelector('.el-blockquote');select(quote,'引用便签测试');
      const beforeComments=(await plugin().store.getDocument(file)).comments.length;
      assert(await plugin().resolveSelection(document,false),'首次便签选区无法解析');
      let returned=false;let pending=plugin().createComment(document);pending.then(()=>returned=true);
      try{{await wait(()=>activeWindow.document.querySelector('.axl-modal-cancel'),'首次便签模态框未打开');}}catch(error){{throw Error(error.message+JSON.stringify({{returned,pdf:plugin().pdfLayerFor(document).isPdfActive(),notices:[...document.querySelectorAll('.notice')].map(e=>e.textContent),selection:document.getSelection().toString(),modals:document.querySelectorAll('.modal').length}}));}}
      activeWindow.document.querySelector('.axl-modal-cancel').click();await pending;
      assert((await plugin().store.getDocument(file)).comments.length===beforeComments,'取消便签仍写入');
      const currentQuote=view.previewMode.containerEl.querySelector('.el-blockquote');select(currentQuote,'引用便签测试');
      assert(await plugin().resolveSelection(document,false),'再次便签选区无法解析');
      pending=plugin().createComment(document);await wait(()=>activeWindow.document.querySelector('.axl-modal-save'),'再次便签模态框未打开');activeWindow.document.querySelector('.axl-modal-textarea').value='合成验收便签';activeWindow.document.querySelector('.axl-modal-save').click();await pending;
      assert((await plugin().store.getDocument(file)).comments.length===beforeComments+1,'提交便签未保存');
      s.results.push('便签模态框取消与提交');
      await leaf.setViewState({{type:'markdown',state:{{file:file.path,mode:'source'}}}});view=leaf.view;
      await wait(()=>view.containerEl.querySelector('.cm-table-widget .axl-highlight--green'),'编辑表格高亮不可见');
      const at=view.getViewData().indexOf('视频模型');view.editor.setSelection(view.editor.offsetToPos(at),view.editor.offsetToPos(at+4));view.editor.focus();
      await plugin().createHighlight('blue',document);
      assert(view.containerEl.querySelector('.axl-highlight--blue'),'编辑模式未显示高亮');
      await leaf.setViewState({{type:'markdown',state:{{file:file.path,mode:'preview'}}}});view=leaf.view;
      await wait(()=>view.previewMode.containerEl.querySelector('.axl-highlight--blue'),'编辑高亮在阅读模式不可见');
      s.results.push('编辑创建→阅读显示');
      const scroll=view.previewMode.getScroll();await app.vault.modify(s.files[1],'独立文档写入验收：已保存');await new Promise(r=>setTimeout(r,100));assert(view.previewMode.getScroll()===scroll,'其他文档保存干扰阅读位置');
      s.results.push('其他文档保存不改变阅读位置');
      s.ids=(await plugin().store.getDocument(file)).highlights.map(m=>m.id);
      await plugin().activateSidebar();const sidebar=app.workspace.getLeavesOfType('axl-light-sidebar')[0].view;await sidebar.render();
      assert(sidebar.containerEl.querySelectorAll('.axl-ov-card').length>0,'侧栏缺少标注卡片');
      const selector=sidebar.containerEl.querySelector('select.axl-filter-select');selector.value='blue';selector.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,50));
      assert(sidebar.containerEl.querySelectorAll('.axl-ov-card').length===1,'侧栏颜色筛选错误');
      sidebar.containerEl.querySelector('[data-action="jump"]').click();await new Promise(r=>setTimeout(r,100));
      s.results.push('侧栏筛选与阅读跳转');
      const addNote=sidebar.containerEl.querySelector('[data-action="add-note"]');addNote.click();
      const draft=sidebar.containerEl.querySelector('.axl-ov-textarea');draft.value='侧栏未保存草稿';
      await plugin().refreshAnnotations();assert(draft.isConnected && draft.value==='侧栏未保存草稿','后台刷新丢弃未保存草稿');
      sidebar.containerEl.querySelector('.axl-ov-cancel').click();
      const exported=await plugin().store.exportNotes(file);s.files.push(exported);assert((await app.vault.cachedRead(exported)).includes('合成验收便签'),'导出缺少便签');
      s.results.push('侧栏草稿保留与 Markdown 导出');
      return JSON.stringify({{checks:s.results,highlightCount:s.ids.length}});
    }})()"""
    result['markdown'] = evaluate(markdown)
    result['pdfOpen'] = evaluate("""(async()=>{const s=window.__axlAudit;await s.leaf.openFile(s.files[2]);await app.workspace.revealLeaf(s.leaf);return JSON.stringify({opened:true});})()""")
    pdf = f"""(async()=>{{{helpers}
      const s=window.__axlAudit;
      await wait(()=>s.leaf.view.containerEl.querySelector('.textLayer span'),'PDF 文字层未就绪');
      const root=s.leaf.view.containerEl;select(root.querySelector('.textLayer'),'PDF annotation');
      await plugin().createHighlight('pink',root.ownerDocument);
      await wait(()=>root.querySelector('.axl-pdf-highlight'),'PDF 高亮未显示');
      const data=await plugin().store.getDocument(s.files[2]);assert(data.pdfHighlights.length===1,'PDF 未保存');
      root.querySelector('.axl-pdf-highlight').click();await wait(()=>root.ownerDocument.querySelector('.axl-pdf-popover'),'PDF 弹窗未打开');
      select(root.querySelector('.textLayer'),'verification');root.ownerDocument.getSelection().removeAllRanges();root.ownerDocument.dispatchEvent(new Event('selectionchange'));
      await plugin().createHighlight('pink',root.ownerDocument);assert((await plugin().store.getDocument(s.files[2])).pdfHighlights.length===1,'取消选区仍复用 PDF 位置');
      select(root.querySelector('.textLayer'),'verification');const pending=plugin().createComment(root.ownerDocument);
      await wait(()=>activeWindow.document.querySelector('.axl-modal-save'),'PDF 便签框未打开');activeWindow.document.querySelector('.axl-modal-textarea').value='PDF 合成便签';
      root.ownerDocument.getSelection().removeAllRanges();root.ownerDocument.dispatchEvent(new root.ownerDocument.defaultView.Event('selectionchange'));
      activeWindow.document.querySelector('.axl-modal-save').click();await pending;
      assert((await plugin().store.getDocument(s.files[2])).pdfComments.length===1,'PDF 模态框丢失原选区');
      const viewer=s.leaf.view.viewer.child.pdfViewer.pdfViewer;viewer.currentScale=1.1;
      await new Promise(r=>setTimeout(r,150));viewer.container.dispatchEvent(new Event('scroll',{{bubbles:true}}));
      await new Promise(r=>setTimeout(r,60));
      const anchor=data.pdfHighlights[0].anchor.rects[0],page=root.querySelector('.page[data-page-number="1"]'),overlay=root.querySelector('[data-axl-id="'+data.pdfHighlights[0].id+'"]');
      assert(Math.abs(overlay.getBoundingClientRect().left-(page.getBoundingClientRect().left+anchor.left*page.getBoundingClientRect().width))<3,'PDF 缩放或滚动后位置偏移');
      return JSON.stringify({{created:true,popover:true,clearedSelectionRejected:true,commentModalPreservesSelection:true,zoomAndScroll:true}});
    }})()"""
    result['pdf'] = evaluate(pdf)
    result['windows'] = evaluate(f"""(async()=>{{{helpers}
      const s=window.__axlAudit,leaf=app.workspace.getLeaf('window');s.extraLeaves=[leaf];await leaf.openFile(s.files[0]);await app.workspace.revealLeaf(leaf);
      await leaf.setViewState({{type:'markdown',state:{{file:s.files[0].path,mode:'preview'}}}});
      const root=leaf.view.previewMode.containerEl,doc=root.ownerDocument;
      await wait(()=>root.querySelector('.el-p'),'独立窗口未渲染');assert(doc!==document,'未创建真实独立窗口');
      const paragraph=[...root.querySelectorAll('.el-p')].find(e=>e.textContent.includes('阅读创建测试'));select(paragraph,'视频模型',1);
      const before=(await plugin().store.getDocument(s.files[0])).highlights.length;
      await plugin().createHighlight('orange',doc);await wait(()=>root.querySelector('.axl-highlight--orange'),'独立窗口高亮未显示');
      const data=await plugin().store.getDocument(s.files[0]);assert(data.highlights.length===before+1,'独立窗口未写入');
      const latest=data.highlights.find(m=>m.color==='orange');assert(latest.anchor.startOffset===leaf.view.getViewData().indexOf('视频模型',leaf.view.getViewData().indexOf('视频模型')+1),'同段第二处错位');
      s.ids=data.highlights.map(m=>m.id);
      await leaf.openFile(s.files[2]);await app.workspace.revealLeaf(leaf);await wait(()=>leaf.view.containerEl.querySelector('.textLayer span'),'独立窗口 PDF 未渲染');
      select(leaf.view.containerEl.querySelector('.textLayer'),'text');await plugin().createHighlight('blue',doc);
      await wait(()=>leaf.view.containerEl.querySelector('.axl-pdf-highlight--blue'),'独立窗口 PDF 高亮不可见');
      assert((await plugin().store.getDocument(s.files[2])).pdfHighlights.length===2,'独立窗口 PDF 保存失败');
      leaf.detach();s.extraLeaves=[];await app.workspace.revealLeaf(s.leaf);
      return JSON.stringify({{markdown:true,secondOccurrence:true,pdf:true,closedCleanly:true}});
    }})()""")
    subprocess.check_output(['obsidian', 'plugin:reload', 'id='+PLUGIN], text=True)
    result['reload'] = evaluate(f"""(async()=>{{{helpers}
      const s=window.__axlAudit;await s.leaf.openFile(s.files[0]);await s.leaf.setViewState({{type:'markdown',state:{{file:s.files[0].path,mode:'preview'}}}});
      const data=await plugin().store.getDocument(s.files[0]);assert(s.ids.every(id=>data.highlights.some(m=>m.id===id)),'重载后记录丢失');
      await wait(()=>s.leaf.view.previewMode.containerEl.querySelector('.axl-highlight--blue'),'重载后阅读高亮不可见');
      assert(document.querySelectorAll('.axl-selection-toolbar').length===1,'重载重复注册工具条');
      return JSON.stringify({{persisted:data.highlights.length,comments:data.comments.length,toolbarCount:document.querySelectorAll('.axl-selection-toolbar').length}});
    }})()""")
except Exception as error:
    result['failure'] = evaluate("""(()=>{const s=window.__axlAudit;if(!s)return JSON.stringify({});const p=app.plugins.plugins['axl-light-zh'];return JSON.stringify({checks:s.results,source:s.leaf?.view.getViewData?.(),html:s.leaf?.view.containerEl.outerHTML,marks:p.store.getCachedDocument(s.files[0]?.path)?.highlights});})()""")
    raise
finally:
    result['cleanup'] = evaluate(f"""(async()=>{{
      const s=window.__axlAudit;if(!s)return JSON.stringify({{nothingCreated:true}});
      const p=app.plugins.plugins['axl-light-zh'];await p.store.writes;
      const recovery='.trash/'+s.prefix;if(!(await app.vault.adapter.exists(recovery)))await app.vault.adapter.mkdir(recovery);
      for(const leaf of s.extraLeaves??[])leaf.detach();
      for(const modal of p.commentModals)modal.close();
      s.leaf?.detach();
      for(const file of s.files){{
        const sidecar=p.store.toSidecarPath(file.path);
        if(await app.vault.adapter.exists(sidecar))await app.vault.adapter.rename(sidecar,recovery+'/'+sidecar.split('/').pop());
        delete p.store.index.files[file.path];
        const existing=app.vault.getAbstractFileByPath(file.path);if(existing)await app.fileManager.trashFile(existing);
      }}
      await p.store.writeIndex();if(s.original?.view)await app.workspace.revealLeaf(s.original);
      const saved={{recovery,filesRemoved:s.files.every(file=>!app.vault.getAbstractFileByPath(file.path))}};delete window.__axlAudit;
      return JSON.stringify(saved);
    }})()""")
    print(json.dumps(result, ensure_ascii=False, indent=2))
