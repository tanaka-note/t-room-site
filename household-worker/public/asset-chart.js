(() => {
  'use strict';
  const yenFormat = new Intl.NumberFormat('ja-JP', {style:'currency', currency:'JPY', maximumFractionDigits:0});
  const yen = value => yenFormat.format(value);
  const monthIndex = month => Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
  const monthAt = index => `${Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`;
  const monthLabel = month => `${Number(month.slice(0,4))}年${Number(month.slice(5))}月末`;
  const startMonth = '2022-06';
  const periods = Object.freeze([
    {key:'1',label:'1ヶ月',months:1,unlock:0},{key:'3',label:'3ヶ月',months:3,unlock:0},
    {key:'6',label:'6ヶ月',months:6,unlock:3},{key:'12',label:'1年',months:12,unlock:6},
    {key:'24',label:'2年',months:24,unlock:12},{key:'36',label:'3年',months:36,unlock:24},
    {key:'60',label:'5年',months:60,unlock:36},{key:'84',label:'7年',months:84,unlock:60},
    {key:'120',label:'10年',months:120,unlock:84},{key:'all',label:'全期間',months:null,unlock:0}
  ]);
  function availablePeriods(points) {
    const span = points.length ? monthIndex(points.at(-1).month) - monthIndex(points[0].month) : 0;
    return periods.filter(period => period.unlock <= span);
  }

  function periodPoints(points, period) {
    if (!points.length) return [];
    const definition = periods.find(item => item.key === period);
    if (!definition?.months) return points.slice();
    const last = monthIndex(points.at(-1).month);
    // Match My Investment's inclusive calendar boundary: one month has two month-end observations.
    const from = last - definition.months;
    return points.filter(point => monthIndex(point.month) >= from && monthIndex(point.month) <= last);
  }
  function periodComparison(points, point, period, firstMonth) {
    const months=periods.find(p=>p.key===period)?.months;
    const baselineMonth=months?monthAt(monthIndex(point.month)-months):firstMonth;
    const label=!months?'開始月末比':months===1?'前月末比':months%12===0?
      `${months/12}年前の月末比`:`${months}ヶ月前の月末比`;
    const baseline=points.find(p=>p.month===baselineMonth&&Number.isFinite(p.value));
    return {baselineMonth,label,value:baseline?point.value-baseline.value:null};
  }

  function axis(values) {
    const min = Math.min(...values), max = Math.max(...values), spread = max - min;
    // Pad the observed change, not the asset amount; retain a small range for flat data.
    const padding = spread > 0 ? spread * .05 : Math.max(Math.abs(max) * .0005, 1);
    const low = min - padding, high = max + padding;
    const rawStep = (high - low) / 4, power = 10 ** Math.floor(Math.log10(rawStep));
    const step = Math.max(1, Math.ceil([1, 2, 2.5, 5, 10].find(number => number * power >= rawStep) * power));
    const magnitude = Math.max(Math.abs(low), Math.abs(high));
    const [unit, label] = magnitude >= 1e12 ? [1e12, '兆円'] : magnitude >= 1e8 ? [1e8, '億円'] : magnitude >= 1e4 ? [1e4, '万円'] : [1, '円'];
    const trailingZeros = String(step).match(/0+$/)?.[0].length || 0;
    const precision = Math.max(0, Math.round(Math.log10(unit)) - trailingZeros);
    const first = Math.ceil(low / step), last = Math.floor(high / step);
    const ticks = Array.from({length: last - first + 1}, (_, i) => (first + i) * step);
    const format = value => (Object.is(value, -0) ? 0 : value / unit).toLocaleString('ja-JP', {maximumFractionDigits:precision});
    return {low, high, ticks, label, format};
  }

  function xTicks(first, last, width) {
    const start = monthIndex(first), end = monthIndex(last), span = end - start;
    if (!span) return [{index:start, label:first.replace('-', '/')}];
    const count = Math.max(2, Math.min(7, Math.floor(width / 78) + 1));
    const step = [1,2,3,6,12,24,36,60,120,240].find(number => number >= span / (count - 1)) || Math.ceil(span / (count - 1));
    const label = index => span >= 24 ? `${Math.floor(index / 12)}年` : monthAt(index).replace('-', '/');
    const ticks = [{index:start, label:label(start)}];
    const minDistance = Math.min(78, width / 2);
    for (let index = Math.ceil((start + 1) / step) * step; index < end; index += step) {
      if ((index - ticks.at(-1).index) / span * width < minDistance || (end - index) / span * width < minDistance) continue;
      if (label(index) !== ticks.at(-1).label && label(index) !== label(end)) ticks.push({index, label:label(index)});
    }
    ticks.push({index:end, label:label(end)});
    return ticks;
  }

  function nearest(points, index) {
    let left = 0, right = points.length - 1;
    while (left < right) {const middle = Math.floor((left + right) / 2); if (monthIndex(points[middle].month) < index) left = middle + 1; else right = middle;}
    return left && index - monthIndex(points[left - 1].month) <= monthIndex(points[left].month) - index ? left - 1 : left;
  }

  function create({root, month, value, change, live}) {
    const ns = 'http://www.w3.org/2000/svg';
    let points = [], comparison = [], selected = null, selectedIndex = -1, busy = false, frame = null, painting = null;
    let period='all',firstMonth=null;
    let readouts=[],displayedIndex=-1,moveFrame=null,pendingMove=null,gesture=null;
    function cancelMove(){if(moveFrame!==null)cancelAnimationFrame(moveFrame);moveFrame=null;pendingMove=null;}
    function releaseGesture(){const active=gesture;gesture=null;if(active?.overlay.hasPointerCapture(active.id))active.overlay.releasePointerCapture(active.id);}
    function stopInteraction(){cancelMove();releaseGesture();}
    function queueMove(index,commit){
      pendingMove={index,commit};
      if(moveFrame!==null)return;
      moveFrame=requestAnimationFrame(()=>{moveFrame=null;const pending=pendingMove;pendingMove=null;if(!busy&&pending){if(pending.commit)select(pending.index);else display(pending.index);}});
    }
    function display(index, announce = false) {
      if (!points.length) return;
      index = Math.max(0, Math.min(points.length - 1, index));
      const text=readouts[index];
      if(displayedIndex!==index){month.textContent=text.month;value.textContent=text.value;change.textContent=text.change;displayedIndex=index;}
      if (painting&&painting.index!==index) {const location = painting.coordinates[index];painting.guide.setAttribute('x1', location.x);painting.guide.setAttribute('x2', location.x);painting.dot.setAttribute('cx', location.x);painting.dot.setAttribute('cy', location.y);painting.index=index;}
      if (announce){const message=`${text.month}、${text.value}、${text.change}`;if(live.textContent!==message)live.textContent=message;}
    }
    function select(index, announce = false) {
      if (!points.length) return;
      selectedIndex = Math.max(0, Math.min(points.length - 1, index));selected = points[selectedIndex].month;
      display(selectedIndex, announce);
    }
    function draw() {
      const width = Math.round(root.getBoundingClientRect().width);
      if (!width) return; // A hidden view must never determine the chart geometry.
      if(painting?.width===width)return; // Height-only notifications must not interrupt a captured gesture.
      stopInteraction();
      root.replaceChildren(); painting = null;
      if (!points.length) {const empty = document.createElement('p');empty.className = 'empty';empty.textContent = 'この期間の月末記録はありません。';root.append(empty);return;}
      const height = width < 560 ? 240 : 320, right = width - 14, top = 28, bottom = height - 36;
      const scale = axis(points.map(point => point.value));
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = '12px ' + getComputedStyle(root).fontFamily;
      const left = Math.max(64, ...scale.ticks.map(tick => Math.ceil(measure.measureText(scale.format(tick)).width) + 16));
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);svg.setAttribute('width', width);svg.setAttribute('height', height);svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', `${points[0].month}から${points.at(-1).month}、月末残高${points.length}件。マウス、タップ、左右キーで金額を確認できます。`);
      const add = (tag, attributes, text) => {const node = document.createElementNS(ns, tag);for (const [key, item] of Object.entries(attributes)) node.setAttribute(key, item);if (text !== undefined) node.textContent = text;svg.append(node);return node;};
      const start = monthIndex(points[0].month), end = monthIndex(points.at(-1).month);
      const x = index => left + (start === end ? .5 : (index - start) / (end - start)) * (right - left);
      const y = amount => bottom - (amount - scale.low) / (scale.high - scale.low) * (bottom - top);
      add('text', {x:left, y:16, class:'chart-unit'}, `残高（${scale.label}）`);
      for (const tick of scale.ticks) {add('line', {x1:left, x2:right, y1:y(tick), y2:y(tick), class:tick === 0 ? 'chart-grid chart-zero' : 'chart-grid'});add('text', {x:left - 9, y:y(tick) + 4, 'text-anchor':'end', class:'chart-y-tick'}, scale.format(tick));}
      const ticks = xTicks(points[0].month, points.at(-1).month, right - left);
      for (const [i, tick] of ticks.entries()) add('text', {x:x(tick.index), y:height - 12, 'text-anchor':ticks.length === 1 ? 'middle' : i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle', class:'chart-x-tick'}, tick.label);
      const coordinates = points.map(point => ({x:x(monthIndex(point.month)), y:y(point.value)}));
      const path = coordinates.map((point, i) => `${i && monthIndex(points[i].month) === monthIndex(points[i - 1].month) + 1 ? 'L' : 'M'}${point.x},${point.y}`).join(' ');
      add('path', {d:path, class:'chart-line', 'vector-effect':'non-scaling-stroke'});
      for (let i = 0; i < points.length; i++) if ((!i || monthIndex(points[i].month) - monthIndex(points[i - 1].month) !== 1) && (i === points.length - 1 || monthIndex(points[i + 1].month) - monthIndex(points[i].month) !== 1)) add('circle', {cx:coordinates[i].x, cy:coordinates[i].y, r:3, class:'chart-isolated'});
      const guide = add('line', {x1:0, x2:0, y1:top, y2:bottom, class:'chart-guide'}), dot = add('circle', {cx:0, cy:0, r:5, class:'chart-selected'});
      const overlay = add('rect', {x:left, y:top, width:right - left, height:bottom - top, fill:'transparent', class:'chart-hit', 'aria-hidden':'true'});
      let bounds=null;
      const current=()=>painting?.overlay===overlay;
      const measureBounds=()=>{const box=svg.getBoundingClientRect(),scale=box.width/width;bounds={left:box.left+left*scale,width:(right-left)*scale};};
      const indexAt=event=>{if(!bounds)measureBounds();const ratio=(event.clientX-bounds.left)/bounds.width;return nearest(points,start+Math.max(0,Math.min(1,ratio))*(end-start));};
      overlay.onpointerenter=event=>{if(current()&&event.pointerType==='mouse')measureBounds();};
      overlay.onpointerdown=event=>{
        if(!current()||busy||gesture||event.isPrimary===false||event.button!==0)return;
        cancelMove();measureBounds();gesture={id:event.pointerId,overlay,startIndex:selectedIndex};
        overlay.setPointerCapture(event.pointerId);select(indexAt(event),true);
      };
      overlay.onpointermove=event=>{if(current()&&!busy&&(event.pointerType==='mouse'||gesture?.id===event.pointerId))queueMove(indexAt(event),gesture?.id===event.pointerId);};
      overlay.onpointerup=event=>{if(!current()||gesture?.id!==event.pointerId)return;cancelMove();if(!busy)select(indexAt(event),true);releaseGesture();};
      overlay.onpointerleave=()=>{if(current()&&!gesture){cancelMove();display(selectedIndex);}};
      const cancelGesture=event=>{if(!current()||gesture?.id!==event.pointerId)return;const original=gesture.startIndex;stopInteraction();select(original);};
      overlay.onpointercancel=cancelGesture;overlay.onlostpointercapture=cancelGesture;
      painting = {coordinates, guide, dot, overlay,width,index:-1};root.append(svg);select(selectedIndex);
    }
    function resize() {if (frame !== null) cancelAnimationFrame(frame);frame = requestAnimationFrame(() => {frame = null;draw();});}
    root.onkeydown = event => {
      if(busy||!points.length)return;
      const index={ArrowLeft:selectedIndex-1,ArrowRight:selectedIndex+1,Home:0,End:points.length-1}[event.key];
      if(index!==undefined){event.preventDefault();stopInteraction();select(index,true);}
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(root);window.addEventListener('resize', resize);
    return {
      update(values, allValues = values, range='all') {
        stopInteraction();
        points = values;comparison = allValues;painting = null;
        if(period!==range)selected=null;period=range;firstMonth=values[0]?.month;
        readouts=points.map(point=>{const result=periodComparison(comparison,point,period,firstMonth),difference=result.value;return {month:monthLabel(point.month),value:yen(point.value),change:difference===null?`${result.label}：比較先の記録なし`:`${result.label} ${difference>0?'＋':difference<0?'−':''}${yen(Math.abs(difference))}`};});
        displayedIndex=-1;
        const found = points.findIndex(point => point.month === selected);selectedIndex = found >= 0 ? found : points.length - 1;
        if (points.length) select(selectedIndex);else {root.replaceChildren();month.textContent = '月末の記録なし';value.textContent = '—';change.textContent = '';live.textContent='';}
        resize();
      },
      resize,
      setBusy(value) {busy = value;if(value)stopInteraction();root.setAttribute('aria-disabled',String(value));}
    };
  }
  globalThis.TRoomAssetChart = Object.freeze({create, startMonth, periods, availablePeriods, monthIndex, monthAt, periodPoints, periodComparison, axis, xTicks, nearest});
})();
