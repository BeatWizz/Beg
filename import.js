'use strict';
// File processing stays on the device; no upload to a server.
const children = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
const firstText = (node, name) => children(node,name)[0]?.textContent?.trim() || '';
const positive = x => Number.isFinite(+x) && +x > 0 ? +x : null;
function xmlDocument(text) {
 const doc = new DOMParser().parseFromString(text,'application/xml');
 if (children(doc,'parsererror').length) throw Error('Повреждённый XML-файл');
 return doc;
}
function validRun(r) {
 return r && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(Date.parse(r.date)) && positive(r.dist) && positive(r.time);
}
function normalizeRun(r) {
 if (!validRun(r)) throw Error('В записи отсутствует дата, дистанция или время');
 return {id:uid(), date:r.date, dist:+r.dist, time:+r.time,
 hr:positive(r.hr), hrMax:positive(r.hrMax), cad:positive(r.cad), vo2:positive(r.vo2),
 note:String(r.note || ''), type:String(r.type || 'Импорт')};
}
function tcxRuns(text) {
 const doc=xmlDocument(text);
 return children(doc,'Activity').map(activity=>{
  const laps=children(activity,'Lap');
  const dist=laps.reduce((n,l)=>n+(+firstText(l,'DistanceMeters')||0),0)/1000;
  const time=laps.reduce((n,l)=>n+(+firstText(l,'TotalTimeSeconds')||0),0);
  let hrSum=0,hrWeight=0,cadSum=0,cadWeight=0;
  for(const l of laps){
   const weight=positive(firstText(l,'TotalTimeSeconds')) || 1;
   const avgHr=children(l,'AverageHeartRateBpm')[0];
   const hr=avgHr ? positive(firstText(avgHr,'Value')) : null;
   if(hr){hrSum+=hr*weight;hrWeight+=weight;}
   // TCX Cadence units vary by producer. Prefer explicitly named RunCadence (strides/min).
   const runCad=positive(firstText(l,'AvgRunCadence'));
   if(runCad){cadSum+=runCad*2*weight;cadWeight+=weight;}
  }
  const points=children(activity,'Trackpoint');
  const hrs=points.map(p=>{const node=children(p,'HeartRateBpm')[0];return node?positive(firstText(node,'Value')):null}).filter(Boolean);
  const cads=points.map(p=>positive(firstText(p,'RunCadence'))).filter(Boolean).map(v=>v*2);
  const maxHrs=children(activity,'MaximumHeartRateBpm').map(n=>positive(firstText(n,'Value'))).filter(Boolean);
  const stamp=firstText(activity,'Id') || laps[0]?.getAttribute('StartTime') || firstText(activity,'Time');
  const date=new Date(stamp);if(!Number.isFinite(+date))throw Error('Нет даты тренировки');
  const hr=hrWeight?hrSum/hrWeight:(hrs.length?avg(hrs):null);
  return normalizeRun({date:localDate(date),dist,time,hr:hr?Math.round(hr):null,
   hrMax:[...maxHrs,...hrs].length?Math.max(...maxHrs,...hrs):null,
   cad:cadWeight?Math.round(cadSum/cadWeight):(cads.length?Math.round(avg(cads)):null),
   vo2:positive(firstText(activity,'VO2Max')),
   note:'Импорт TCX. Каденс RunCadence переведён из циклов в шаги/мин. При отсутствии средних по кругам использовано среднее по точкам.'});
 });
}
function meters(a,b){
 const rad=x=>x*Math.PI/180,R=6371000;
 const dlat=rad(b.lat-a.lat),dlon=rad(b.lon-a.lon);
 const v=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;
 return 2*R*Math.asin(Math.sqrt(Math.min(1,v)));
}
function gpxRuns(text){
 const doc=xmlDocument(text), tracks=children(doc,'trk');
 return tracks.map(track=>{
  let distance=0;const points=[];
  for(const seg of children(track,'trkseg')){
   let prev=null;
   for(const p of children(seg,'trkpt')){
    const lat=Number(p.getAttribute('lat')),lon=Number(p.getAttribute('lon'));
    if(!p.hasAttribute('lat')||!p.hasAttribute('lon')||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)continue;
    const point={lat,lon,time:Date.parse(firstText(p,'time')),hr:positive(firstText(p,'hr'))};
    if(prev)distance+=meters(prev,point);prev=point;points.push(point);
   }
  }
  const times=points.map(p=>p.time).filter(Number.isFinite);
  if(times.length<2)throw Error('GPX без временных меток: нельзя определить длительность');
  const start=Math.min(...times),end=Math.max(...times),hrs=points.map(p=>p.hr).filter(Boolean);
  return normalizeRun({date:localDate(new Date(start)),dist:+(distance/1000).toFixed(3),time:(end-start)/1000,
   hr:hrs.length?Math.round(avg(hrs)):null,hrMax:hrs.length?Math.max(...hrs):null,
   note:'Импорт GPX: дистанция оценена по координатам; время включает остановки. Пульс — среднее по точкам. Каденс GPX не импортируется: единицы зависят от экспортёра.'});
 });
}
function isDuplicate(a,b){return a.date===b.date && Math.abs(+a.dist-+b.dist)<0.005 && Math.abs(+a.time-+b.time)<1;}
document.getElementById('import-button').onclick=()=>document.getElementById('import-file').click();
document.getElementById('import-file').onchange=async e=>{
 const report=[];
 for(const file of e.target.files){
  try{
   if(file.size>30*1024*1024)throw Error('Файл больше 30 МБ');
   const text=await file.text(),extension=file.name.split('.').pop().toLowerCase();
   let incoming;
   if(extension==='tcx')incoming=tcxRuns(text);
   else if(extension==='gpx')incoming=gpxRuns(text);
   else if(extension==='json'){
    const data=JSON.parse(text);incoming=(Array.isArray(data)?data:data.runs);
    if(!Array.isArray(incoming))throw Error('JSON должен содержать массив runs');
    incoming=incoming.map(normalizeRun);
    if(!Array.isArray(data)&&Array.isArray(data.plan)&&confirm('Восстановить также план из резервной копии? Текущий план будет заменён.')){
     const types=['Лёгкая','Длительная','Интервальная','Темповая','Фартлек','Прогрессивная','Восстановительная','Силовая','ОФП','Отдых'];
     const restored=data.plan.map(p=>({id:uid(),day:Math.max(0,Math.min(6,Math.trunc(+p.day)||0)),type:types.includes(p.type)?p.type:'Лёгкая',dist:String(p.dist||''),pace:String(p.pace||''),hr:String(p.hr||''),cad:String(p.cad||''),remind:/^\d{2}:\d{2}$/.test(p.remind)?p.remind:'',desc:String(p.desc||''),done:!!p.done,notified:''}));
     store.set('plan',restored);plan=restored;
    }
   }else throw Error('Поддерживаются только TCX, GPX и JSON; FIT пока не поддерживается');
   if(!incoming.length)throw Error('Тренировок в файле нет');
   const next=[...runs];let count=0;
   for(const r of incoming)if(!next.some(x=>isDuplicate(x,r))){next.push(r);count++;}
   store.set('runs',next);runs=next;
   report.push(file.name+': добавлено '+count+', пропущено повторов '+(incoming.length-count));
  }catch(err){report.push(file.name+': '+err.message);}
 }
 document.getElementById('import-status').textContent=report.join(' • ');
 renderProgress();renderJournal();renderCoach();e.target.value='';
};
// Responsive drawer.
document.getElementById('mobile-menu').onclick=()=>document.body.classList.toggle('menu-open');
document.querySelectorAll('.sub-btn,.menu-btn[data-view]').forEach(b=>b.addEventListener('click',()=>document.body.classList.remove('menu-open')));
// Installation is available only on a secure hosted origin.
let installPrompt=null;
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;});
document.getElementById('install-app').onclick=async()=>{
 if(installPrompt){await installPrompt.prompt();installPrompt=null;}
 else alert('Открой СвятБег на HTTPS-сайте. Android: меню Chrome → Установить приложение. iPhone: Safari → Поделиться → На экран Домой. Из локального файла установка не работает.');
};
if('serviceWorker' in navigator && (location.protocol==='https:'||location.hostname==='localhost')){
 navigator.serviceWorker.register('./sw.js').catch(err=>console.warn('Offline unavailable',err));
}
