(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const money = n => new Intl.NumberFormat('ja-JP', {style:'currency',currency:'JPY',maximumFractionDigits:0}).format(n);
  const today = () => new Date(Date.now()+9*3600000).toISOString().slice(0,10);
  const previousMonth = () => {const d=new Date(`${today()}T00:00:00Z`);d.setUTCDate(0);return d.toISOString().slice(0,7);};
  const nav = TroomDialogNavigation.create({key:'troomHouseholdDialogs'});
  let data={accounts:[],transactions:[],categories:[],snapshots:[],historical:[]}, revision=0, session=null, busy=false, activity=Date.now(), confirmation=null, restoreFile=null, categoryEditing=null;
  const editors=new Map(), channel=typeof BroadcastChannel==='function'?new BroadcastChannel('household-ledger'):null;
  let assetPoints=[], assetChart=null, chartPeriod='all';
  TRoomDatePicker.setNavigation(nav);
  TRoomDateWheel.initialize(nav,()=>busy);
  for(const event of ['click','keydown'])$('period').addEventListener(event,()=>{if($('date-wheel-dialog').open)$('date-wheel-title').textContent='表示月を選択';});
  const moneyNumber=input=>Number(String(input.value).normalize('NFKC').replaceAll(',',''));
  function formatMoney(input){
    const before=input.value,caret=input.selectionStart,plain=before.normalize('NFKC').replaceAll(',','');
    const valid=/^-?\d*$/.test(plain),n=Number(plain),signed=input.dataset.money==='signed';
    input.setCustomValidity(valid&&plain!==''&&plain!=='-'&&Number.isSafeInteger(n)&&Math.abs(n)<=90000000000&&(signed||n>0)?'':'範囲内の整数円で入力してください。');
    if(!valid)return;
    input.value=plain.replace(/\B(?=(\d{3})+(?!\d))/g,',');
    if(caret!==null&&document.activeElement===input){const count=before.slice(0,caret).replaceAll(',','').length;let seen=0,pos=0;while(pos<input.value.length&&seen<count){if(input.value[pos]!==',')seen++;pos++;}input.setSelectionRange(pos,pos);}
  }
  document.addEventListener('input',event=>{if(event.target.matches('[data-money]')&&!event.isComposing)formatMoney(event.target);},true);
  const categoryFor=t=>{const c=data.categories.find(c=>c.id===t.categoryId);return c?.parent==='未分類'?data.categories.find(c=>c.parent==='その他'&&c.name==='その他'):c;};
  const visibleCategories=()=>data.categories.filter(c=>c.parent!=='未分類');
  const totals=a=>a.items.reduce((sum,i)=>sum+i.amount,0);
  const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  function button(label,action,cls=''){const b=el('button',label,cls);b.type='button';b.onclick=action;return b;}
  function options(select,rows,placeholder){const old=select.value;select.replaceChildren();if(placeholder!==undefined){const o=new Option(placeholder,'');select.add(o);}for(const [value,label]of rows)select.add(new Option(label,value));if([...select.options].some(o=>o.value===old))select.value=old;}
  function field(form,name){return form.elements.namedItem(name);}
  function markDirty(){for(const [id,e]of editors){e.form.dataset.troomDirty=String($(id).open&&e.initial!==e.serialize());}document.body.dataset.troomUpdateBlock=String(busy||[...editors].some(([id,e])=>$(id).open&&e.initial!==e.serialize()));}
  function setBusy(value){busy=value;document.body.dataset.troomUpdateBlock=String(value);for(const b of document.querySelectorAll('button'))b.disabled=value;for(const form of document.querySelectorAll('dialog form'))form.inert=value;$('restore').disabled=value||!restoreFile;assetChart?.setBusy(value);updateItemControls();markDirty();}
  async function api(path,body){
    let response;try{response=await fetch(`/household/api${path}`,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(!document.hidden&&Date.now()-activity<60000?{'X-Troom-Activity':'foreground'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}catch{throw new Error('通信できませんでした。入力は保持されています。もう一度お試しください。');}
    const result=await response.json().catch(()=>{throw new Error('応答を読み取れませんでした。もう一度お試しください。');});
    if(response.status===401){session=null;$('app-view').hidden=true;$('login-view').hidden=false;$('login').hidden=false;$('boot-message').textContent='パスキーでログインしてください。';}
    if(!response.ok){const error=new Error(result.error||'処理を完了できませんでした。');error.status=response.status;throw error;}return result;
  }
  function showSession(value){session=value;document.body.classList.toggle('is-viewer',value.role!=='owner');$('account-name').textContent=value.displayName;$('access-mode').textContent=value.role==='owner'?'編集可能':'閲覧専用';$('login-view').hidden=true;$('app-view').hidden=false;}
  async function load(){const result=await api('/data');data=result.data;assetPoints=result.assetHistory||[];revision=result.revision;render();$('message').textContent='';}
  async function mutate(operation,value,expectedRevision=revision,requestId=crypto.randomUUID()){await api('/mutate',{operation,value,expectedRevision,requestId});await load();channel?.postMessage('changed');}
  const formValues=form=>Object.fromEntries(new FormData(form));
  function ask(title,copy,action){$('confirm-title').textContent=title;$('confirm-copy').textContent=copy;$('confirm-error').textContent='';confirmation=action;nav.open('confirm-dialog');}
  nav.register('confirm-dialog',{blocked:()=>busy,guard:()=>!busy,onClose:()=>{confirmation=null;}});
  $('confirm-cancel').onclick=()=>nav.close('confirm-dialog');
  $('confirm-ok').onclick=async()=>{if(busy||!confirmation)return;const action=confirmation;setBusy(true);try{await action();setBusy(false);if($('confirm-dialog').open)await nav.close('confirm-dialog',{force:true});}catch(error){$('confirm-error').textContent=error.message;if(error.status===409)confirmation=null;}finally{setBusy(false);}};
  function editor(id,formId,serialize,save){
    const form=$(formId),e={form,serialize,initial:'',id:null,expectedRevision:0,requestId:null};editors.set(id,e);
    nav.register(id,{blocked:()=>busy,guard:()=>{if(busy)return false;if(e.initial===serialize())return true;ask('入力内容を破棄しますか？','保存していない入力内容があります。',async()=>{await nav.close('confirm-dialog',{force:true});await nav.close(id,{force:true});});return false;},onClose:()=>{form.reset();e.initial=serialize();e.id=null;e.requestId=null;markDirty();}});
    for(const event of ['input','change'])form.addEventListener(event,()=>{e.requestId=null;markDirty();});
    form.onsubmit=async event=>{event.preventDefault();if(busy||!form.reportValidity())return;e.requestId||=crypto.randomUUID();$(formId.replace('-form','-error')).textContent='';setBusy(true);try{await save(e);setBusy(false);await nav.close(id,{force:true});}catch(error){$(formId.replace('-form','-error')).textContent=error.message;}finally{setBusy(false);}};
    return e;
  }
  function open(id,e,recordId){e.id=recordId||crypto.randomUUID();e.expectedRevision=revision;e.requestId=null;e.initial=e.serialize();$(id.replace('-dialog','-error')).textContent='';nav.open(id);markDirty();}
  for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>nav.close(b.dataset.close);
  const entryForm=$('entry-form');
  function entryValue(){const v=formValues(entryForm);return {...v,amount:moneyNumber(field(entryForm,'amount'))};}
  const entryEditor=editor('entry-dialog','entry-form',()=>JSON.stringify(entryValue()),e=>mutate('transaction.save',{...entryValue(),id:e.id},e.expectedRevision,e.requestId));
  function fillEntryCategories(parent){const type=field(entryForm,'type').value,cats=visibleCategories().filter(c=>c.type===type);options($('entry-parent'),[...new Set(cats.map(c=>c.parent))].map(p=>[p,p]));if(parent&&cats.some(c=>c.parent===parent))$('entry-parent').value=parent;options(field(entryForm,'categoryId'),cats.filter(c=>c.parent===$('entry-parent').value).map(c=>[c.id,c.name]));}
  function openEntry(record){if(session?.role!=='owner'||record?.type==='transfer')return;entryForm.reset();$('entry-title').textContent=record?'明細を編集':'明細を登録';field(entryForm,'date').value=record?.date||today();field(entryForm,'type').value=record?.type||'expense';const category=record?categoryFor(record):null;fillEntryCategories(category?.parent);if(record){for(const key of ['amount','description','notes'])field(entryForm,key).value=record[key]??'';field(entryForm,'categoryId').value=category?.id||'';}formatMoney(field(entryForm,'amount'));open('entry-dialog',entryEditor,record?.id);}
  field(entryForm,'type').onchange=()=>fillEntryCategories();$('entry-parent').onchange=()=>fillEntryCategories($('entry-parent').value);$('add-entry').onclick=()=>openEntry();
  const accountForm=$('account-form');
  function updateItemControls(){const rows=[...$('account-items').children];for(const [i,row]of rows.entries()){row.querySelector('[data-move=up]').disabled=busy||i===0;row.querySelector('[data-move=down]').disabled=busy||i===rows.length-1;}}
  function moveItem(row,direction){const focus=document.activeElement,other=direction<0?row.previousElementSibling:row.nextElementSibling;if(!other)return;if(direction<0)other.before(row);else other.after(row);accountEditor.requestId=null;updateItemControls();markDirty();focus?.focus({preventScroll:true});}
  function itemRow(item={id:crypto.randomUUID(),name:'',amount:0}){
    const row=el('div',undefined,'item-editor');row.dataset.id=item.id;
    for(const [name,label,value]of [['name','内訳名',item.name],['amount','残高（円）',item.amount]]){const l=el('label',label),i=el('input');i.dataset.field=name;i.type='text';i.value=value;i.required=true;if(name==='amount'){i.dataset.money='signed';i.inputMode='decimal';formatMoney(i);}else i.maxLength=80;l.append(i);row.append(l);}
    const actions=el('div',undefined,'item-actions');for(const [direction,label,text]of [[-1,'上へ移動','↑'],[1,'下へ移動','↓']]){const b=button(text,()=>moveItem(row,direction));b.dataset.move=direction<0?'up':'down';b.setAttribute('aria-label',label);actions.append(b);}
    actions.append(button('削除',()=>ask('この内訳を削除しますか？',row.querySelector('[data-field=name]').value||'名称未入力の内訳',()=>{row.remove();accountEditor.requestId=null;updateItemControls();markDirty();}),'danger'));row.append(actions);$('account-items').append(row);updateItemControls();
  }
  function accountValue(){const v=formValues(accountForm);return {...v,archived:field(accountForm,'archived').checked,items:[...$('account-items').children].map(row=>({id:row.dataset.id,name:row.querySelector('[data-field=name]').value,amount:moneyNumber(row.querySelector('[data-field=amount]'))}))};}
  const accountEditor=editor('account-dialog','account-form',()=>JSON.stringify(accountValue()),e=>mutate('account.save',{...accountValue(),id:e.id},e.expectedRevision,e.requestId));
  let editingAccount=null;
  function fillBalance(items){$('account-items').replaceChildren();for(const item of items)itemRow(item);}
  function openAccount(record){
    if(session?.role!=='owner')return;
    editingAccount=record||null;accountForm.reset();$('account-title').textContent=record?'口座と残高を編集':'口座を作成';
    field(accountForm,'name').value=record?.name||'';field(accountForm,'type').value=record?.type||'その他';field(accountForm,'archived').checked=record?.archived||false;
    field(accountForm,'asOf').max=today();field(accountForm,'asOf').value=today();field(accountForm,'asOf').readOnly=true;
    options($('balance-history'),[...(record?.balances||[])].reverse().map(b=>[b.date,`${b.date} 時点`]),'新しい基準日の残高を入力');$('balance-history').value='';
    fillBalance(record?.items||[{id:crypto.randomUUID(),name:'残高',amount:0}]);open('account-dialog',accountEditor,record?.id);
  }
  $('balance-history').onchange=()=>{
    const date=$('balance-history').value,selected=editingAccount?.balances?.find(b=>b.date===date);
    if(selected){field(accountForm,'asOf').value=date;fillBalance(selected.items);}else{field(accountForm,'asOf').value=today();fillBalance(editingAccount?.items||[{id:crypto.randomUUID(),name:'残高',amount:0}]);}
    accountEditor.requestId=null;markDirty();
  };
  field(accountForm,'asOf').addEventListener('change',()=>{const selected=editingAccount?.balances?.find(b=>b.date===field(accountForm,'asOf').value);if(selected){fillBalance(selected.items);$('balance-history').value=selected.date;}else $('balance-history').value='';markDirty();});
  $('add-account').onclick=()=>openAccount();$('add-item').onclick=()=>{itemRow();accountEditor.requestId=null;markDirty();};
  function cell(row,value,cls=''){const td=el('td',value,cls);row.append(td);return td;}
  function renderTransactions(){
    const period=$('period').value,year=$('period-mode').value==='year',prefix=year?period.slice(0,4):period,query=$('search').value.normalize('NFKC').toLocaleLowerCase();
    const rows=data.transactions.filter(t=>{const c=categoryFor(t);return t.date.startsWith(prefix)&&(!$('category-filter').value||c?.parent===$('category-filter').value)&&      (t.description+' '+t.notes+' '+(c?.parent||'')+' '+(c?.name||'')).normalize('NFKC').toLocaleLowerCase().includes(query);}).sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
    let income=0,expense=0;const groups=new Map(),root=$('entries');root.replaceChildren();
    for(const t of rows){const c=categoryFor(t),legacy=t.type==='transfer';if(!legacy){if(t.type==='income')income+=t.amount;else expense+=t.amount;const key=(t.type==='income'?'収入':'支出')+' / '+(c?.parent||'その他');groups.set(key,(groups.get(key)||0)+t.amount);}
      const tr=el('tr');tr.dataset.id=t.id;cell(tr,t.date);cell(tr,t.description||'（内容なし）','description');cell(tr,legacy?'過去の振替（集計外）':(c?.parent||'その他')+' / '+(c?.name||'その他'));cell(tr,(t.type==='income'?'＋':t.type==='expense'?'−':'')+money(t.amount),'numeric');cell(tr,t.notes,'notes');
      if(session?.role==='owner'){const actions=cell(tr,undefined,'row-actions');if(!legacy)actions.append(button('編集',()=>openEntry(t)));actions.append(button('削除',()=>{const expected=revision,id=crypto.randomUUID();ask('この明細を削除しますか？',t.date+'\n'+t.description+'\n'+money(t.amount),()=>mutate('transaction.delete',{id:t.id},expected,id));},'danger'));}
      ['日付','内容','分類','金額','メモ','操作'].forEach((label,i)=>{if(tr.cells[i])tr.cells[i].dataset.label=label;});root.append(tr);
    }
    $('income').textContent=money(income);$('expense').textContent=money(expense);$('net').textContent=money(income-expense);$('empty-entries').hidden=rows.length>0;$('entry-count').textContent=rows.length+'件';$('category-summary').replaceChildren();for(const [name,value]of groups){const div=el('div',undefined,'category-stat');div.append(el('span',name),el('strong',money(value)));$('category-summary').append(div);}
  }
  function renderAccounts(){const root=$('accounts');root.replaceChildren();let total=0;for(const a of data.accounts){if(!a.archived)total+=totals(a);const card=el('article',undefined,'panel account-card'),header=el('header'),title=el('div');title.append(el('h3',a.name),el('span',`${a.type}${a.archived?'・保管済み':''}`,'muted small'));header.append(title);if(session?.role==='owner')header.append(button('編集',()=>openAccount(a)));card.append(header,el('p',money(totals(a)),'total'),el('p',a.balances?.length?`${a.balances.at(-1).date} 時点`:'基準日未入力','muted small'));for(const i of a.items){const row=el('div',undefined,'item');row.append(el('span',i.name),el('strong',money(i.amount)));card.append(row);}root.append(card);}$('current-assets').textContent=money(total);$('empty-accounts').hidden=data.accounts.length>0;}
  function points(){return assetPoints;}
  assetChart=TRoomAssetChart.create({root:$('chart'),month:$('chart-month'),value:$('chart-value'),change:$('chart-change'),live:$('chart-live')});
  function renderAssets(){
    const all=points();$('asset-incomplete').textContent=all.some(s=>s.missing?.length)?'基準日未入力の口座がある月は、資産合計を表示できません。口座画面で残高の基準日を入力してください。':'';
    const series=all.map(s=>({...s,value:s.total})).filter(s=>Number.isFinite(s.value));
    const periods=TRoomAssetChart.availablePeriods(all),controls=$('chart-periods');if(!periods.some(p=>p.key===chartPeriod))chartPeriod='all';
    if([...controls.children].map(b=>b.dataset.chartPeriod).join(',')!==periods.map(p=>p.key).join(',')){controls.replaceChildren();for(const p of periods){const b=button(p.label,()=>{chartPeriod=p.key;renderAssets();});b.dataset.chartPeriod=p.key;controls.append(b);}}
    for(const b of controls.children)b.setAttribute('aria-pressed',String(b.dataset.chartPeriod===chartPeriod));
    const months=TRoomAssetChart.periodPoints(all,chartPeriod),wanted=new Set(months.map(s=>s.month)),values=series.filter(s=>wanted.has(s.month));
    $('chart-range').textContent=values.length?`${values[0].month.replace('-','年')}月〜${values.at(-1).month.replace('-','年')}月・${values.length}件の月末記録`:'表示する記録がありません。';
    assetChart.update(values,series,chartPeriod);
    const root=$('snapshots'),openYears=new Set([...root.querySelectorAll('details[open]')].map(d=>d.dataset.year)),rendered=root.childElementCount>0;root.replaceChildren();const groups=new Map();
    for(const s of [...values].reverse()){const year=s.month.slice(0,4);if(!groups.has(year))groups.set(year,[]);groups.get(year).push(s);}
    for(const [year,records]of groups){const group=el('details',undefined,'panel snapshot-year');group.dataset.year=year;group.open=rendered?openYears.has(year):year===values.at(-1).month.slice(0,4);const summary=el('summary');summary.append(el('span',`${year}年`),el('span',`${records.length}件`,'muted small'));group.append(summary);
      const table=el('table',undefined,'snapshot-table'),head=el('thead'),headers=el('tr'),body=el('tbody');for(const label of ['月末','資産合計','基準日・記録'])headers.append(el('th',label));head.append(headers);table.append(head,body);
      for(const s of records){const tr=el('tr');tr.dataset.month=s.month;cell(tr,s.date);cell(tr,money(s.value),'numeric');const dates=s.accounts.map(a=>a.asOf).filter(Boolean).sort();const source=s.sourceAsOf||(dates.length?(dates[0]===dates.at(-1)?dates[0]:`${dates[0]}〜${dates.at(-1)}`):'');cell(tr,`${s.derived?'自動集計':s.historical?'過去の記録':'保存済み記録'}${source?`・${source}時点`:''}${s.provisional||s.date>today()?'（月末前）':''}`,'snapshot-source');body.append(tr);}group.append(table);root.append(group);
    }
    $('empty-assets').hidden=values.length>0;$('asset-record-count').textContent=`${values.length}件`;
  }
  function renderCategories(){const groups=new Map();for(const c of visibleCategories()){if(!groups.has(c.parent))groups.set(c.parent,[]);groups.get(c.parent).push(c);}options($('category-parent'),[...groups.keys()].map(p=>[p,p]));const root=$('categories');root.replaceChildren();for(const [parent,items]of groups){const row=el('div',undefined,'category-group');row.append(el('strong',parent));for(const c of items){if(!c.builtin&&session?.role==='owner'){row.append(button(c.name,()=>{categoryEditing=c;$('category-parent').value=c.parent;field($('category-form'),'name').value=c.name;$('category-form').querySelector('[type=submit]').textContent='変更を保存';$('category-cancel').hidden=false;}),button(`${c.name}を削除`,()=>{const expected=revision;ask('分類を削除しますか？',c.name,()=>mutate('category.delete',{id:c.id},expected));},'danger'));}else row.append(el('span',c.name));}root.append(row);}}
  function render(){options($('category-filter'),[...new Set(visibleCategories().map(c=>c.parent))].map(p=>[p,p]),'すべて');renderTransactions();renderAccounts();renderAssets();renderCategories();showView();}
  function showView(){const view=['transactions','accounts','assets','settings'].includes(location.hash.slice(1))?location.hash.slice(1):'transactions';for(const page of document.querySelectorAll('.page'))page.hidden=page.id!==`view-${view}`;for(const b of document.querySelectorAll('[data-view]')){if(b.dataset.view===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}if(view==='assets')assetChart.resize();}
  for(const b of document.querySelectorAll('[data-view]'))b.onclick=()=>{if(location.hash!==`#${b.dataset.view}`)history.pushState({...history.state,householdView:b.dataset.view},'',`#${b.dataset.view}`);showView();};window.addEventListener('popstate',showView);
  $('period').value=today().slice(0,7);for(const id of ['period','period-mode','category-filter'])$(id).onchange=renderTransactions;$('search').oninput=renderTransactions;
  function resetCategory(){categoryEditing=null;$('category-form').reset();$('category-form').querySelector('[type=submit]').textContent='中項目を追加';$('category-cancel').hidden=true;}
  $('category-cancel').onclick=resetCategory;$('category-form').onsubmit=async event=>{event.preventDefault();if(busy||session?.role!=='owner')return;const value={id:categoryEditing?.id||crypto.randomUUID(),...formValues($('category-form'))};setBusy(true);try{await mutate('category.save',value);resetCategory();}catch(error){$('message').textContent=error.message;}finally{setBusy(false);}};
  async function download(path,filename){if(busy)return;setBusy(true);try{const response=await fetch(`/household/api${path}`,{credentials:'same-origin'});if(!response.ok)throw new Error('保存できませんでした。ログイン状態と通信を確認してください。');const blob=await response.blob(),url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(error){$('message').textContent=error.message;}finally{setBusy(false);}}
  $('export-csv').onclick=()=>download('/export.csv',`家計簿-明細-${today()}.csv`);$('export-backup').onclick=()=>download('/backup',`家計簿-バックアップ-${today()}.json`);
  $('restore-file').onchange=async()=>{restoreFile=null;$('restore').disabled=true;$('restore-preview').textContent='';const file=$('restore-file').files[0];if(!file)return;try{if(file.size>12*1024*1024)throw new Error('12MB以下のバックアップを選んでください。');const value=JSON.parse(await file.text());if(value.format!=='troom-household'||![1,2].includes(value.version)||!value.data)throw new Error('家計簿のバックアップファイルを選んでください。');for(const key of ['accounts','transactions','snapshots','historical','categories'])if(!Array.isArray(value.data[key]))throw new Error('バックアップの形式を確認してください。');restoreFile=value;$('restore-preview').textContent=`口座 ${value.data.accounts.length}件・明細 ${value.data.transactions.length}件・月末記録 ${value.data.snapshots.length+value.data.historical.length}件`;$('restore').disabled=false;}catch(error){$('restore-preview').textContent=error.message;}};
  $('restore').onclick=()=>{if(!restoreFile||busy)return;const saved=restoreFile,expected=revision,id=crypto.randomUUID();ask('バックアップを復元しますか？',`${$('restore-preview').textContent}\n現在の家計データを、このバックアップの内容へ切り替えます。`,async()=>{await api('/restore',{requestId:id,expectedRevision:expected,backup:saved});restoreFile=null;$('restore-file').value='';$('restore-preview').textContent='';await load();channel?.postMessage('changed');});};
  $('login').onclick=async()=>{if(busy)return;$('login-error').textContent='';$('passkey-login-label').textContent='確認中…';setBusy(true);try{const auth=await TRoomPasskeys.authenticate('household');showSession(await api('/passkey/handoff',{handoffToken:auth.handoff.handoffToken}));await load();}catch(error){$('login-error').textContent=error.message;}finally{$('passkey-login-label').textContent='パスキーでログイン';setBusy(false);}};
  $('logout').onclick=async()=>{if(busy)return;setBusy(true);try{await api('/logout',{});session=null;data={accounts:[],transactions:[],categories:[],snapshots:[],historical:[]};assetPoints=[];render();nav.reset();restoreFile=null;$('restore-file').value='';$('app-view').hidden=true;$('login-view').hidden=false;$('login').hidden=false;$('boot-message').textContent='パスキーでログインしてください。';channel?.postMessage('session-changed');}catch(error){$('message').textContent=error.message;}finally{setBusy(false);}};
  $('refresh').onclick=async()=>{setBusy(true);try{await load();}catch(error){$('message').textContent=error.message;}finally{setBusy(false);}};
  for(const type of ['pointerdown','keydown','touchstart','wheel'])window.addEventListener(type,event=>{if(event.isTrusted)activity=Date.now();},{passive:true,capture:true});
  channel&&(channel.onmessage=()=>{if(session)$('message').textContent='別の画面で状態が変わりました。「最新の状態に更新」で確認してください。';});
  document.addEventListener('troom:before-auto-update',event=>{if(busy||$('date-wheel-dialog').open||$('troom-calendar-dialog').open)event.preventDefault();});
  window.addEventListener('beforeunload',event=>{if(busy||[...editors].some(([id,e])=>$(id).open&&e.initial!==e.serialize())){event.preventDefault();event.returnValue='';}});
  (async()=>{try{showSession(await api('/session'));await load();}catch(error){$('boot-message').textContent=error.status===401?'パスキーでログインしてください。':error.message;$('login').hidden=false;}})();
})();
