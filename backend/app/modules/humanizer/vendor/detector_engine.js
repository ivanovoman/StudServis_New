
'use strict';
// ═══════════════════════════════════════════════════════════
// MDEF — 59 активных метрик [id, name, cluster, w, tau, is_human]
// ═══════════════════════════════════════════════════════════
const MDEF=[
 // K1 Лексика τ=1.5
 [1,'Клише 2026','K1',9,1.5,false],[2,'Маркеры ИИ','K1',7,1.5,false],
 [19,'Вводные','K1',8,1.5,false],[16,'Абстр.сущ.','K1',7,1.5,false],[21,'PIW','K1',8,1.5,false],
 // K2 Оформление τ=1.5
 [56,'Em dash','K2',7,1.5,false],[57,'Markdown','K2',4,1.5,false],[69,'AI-оговорки','K2',9,1.5,false],
 // K3 Стат. τ=1.0
 [3,'TTR','K3',2,1.0,false],[32,'Evenness','K3',8,1.0,false],[33,'MTLD','K3',6,1.0,false],
 [34,'MATTR','K3',4,1.0,false],[35,'HD-D','K3',4,1.0,false],[38,'Dispersion','K3',8,1.0,false],
 // K4 Ритм τ=1.0
 [4,'Перплексия','K4',2,1.0,false],[5,'Burstiness AI','K4',5,1.0,false],
 [6,'CV абзацев','K4',4,1.0,false],[44,'SentPplVar','K4',8,1.0,false],
 // K5 Структура τ=0.8
 [7,'Введ/Закл','K5',5,0.8,false],[8,'3-частность','K5',7,0.8,false],
 [18,'Симм.списки','K5',7,0.8,false],[55,'SemDelay','K5',7,0.8,false],
 // K6 Нейтральность τ=0.8
 [10,'Нет эмоций','K6',6,0.8,false],[13,'Сбаланс.','K6',5,0.8,false],
 [14,'Сем.нейтр.','K6',5,0.8,false],[20,'Нет противор.','K6',6,0.8,false],[31,'Hedging','K6',7,0.8,false],
 // K7 Синтаксис τ=0.8
 [15,'Синт.паттерн','K7',10,0.8,false],[49,'SOE','K7',8,0.8,false],[50,'NIR/CR','K7',8,0.8,false],[76,'SelfRef','K7',6,0.8,false],
 // K8 Дискурс τ=0.6
 [39,'NomShare','K8',8,0.6,false],[40,'Специфичн.','K8',7,0.6,false],
 [42,'RST contrast','K8',8,0.6,false],[43,'TopicMono','K8',7,0.6,false],
 [48,'GL-CLiC','K8',8,0.6,false],[75,'ExplainOver','K8',7,0.6,false],
 // KG Grok/GigaChat τ=1.0 (новые 2026)
 [78,'NomRhythm','KG',8,1.0,false],
 [79,'CrossStyle','KG',7,1.0,false],
 // H1 Прям.маркеры τ=1.5
 [25,'Сленг 2026','H1',6,1.5,true],[26,'Я-нарратив','H1',7,1.5,true],
 [27,'Сомнения','H1',7,1.5,true],[28,'Эмоции','H1',6,1.5,true],
 // H2 Живой ритм τ=1.0
 [29,'Живой ритм','H2',8,1.0,true],[23,'Стиль.сдвиг','H2',8,1.0,true],
 [46,'SLT','H2',6,1.0,true],
 // H3 Нелинейность τ=0.8
 [41,'Нелинейн.','H3',7,0.8,true],[22,'Грамм.шерох.','H3',7,0.8,true],[47,'ErrCons','H3',6,0.8,true],
 // H4 BioSpec τ=1.2
 [63,'BioSpec','H4',6,1.2,true],[73,'ImplicitRef','H4',6,1.2,true],
 // H5 Пунктуация τ=1.0
 [45,'QuotUsage','H5',5,1.0,true],[72,'Hapax_Novel','H5',5,1.0,true],
 // K9 Худ.проза τ=1.5
 [61,'Коротк.абз.','K9',7,1.5,true],
 // HA Акад. τ=1.4
 ['fn','Сноски[n]','HA',7,1.4,true],['pw','Полемика-мы','HA',7,1.2,true],
 // HE EDNL τ=1.5 (новые 2026)
 [82,'EDNL','HE',9,1.5,true],[83,'CapEmphasis','HE',6,1.5,true],
];

const CMETA={
 K1:{n:'K1 Лексика',   hu:false,tau:1.5,col:'#FF4444'},
 K2:{n:'K2 Оформл.',   hu:false,tau:1.5,col:'#FF6644'},
 K3:{n:'K3 Стат.',     hu:false,tau:1.0,col:'#FF8844'},
 K4:{n:'K4 Ритм',      hu:false,tau:1.0,col:'#FFAA44'},
 K5:{n:'K5 Структ.',   hu:false,tau:0.8,col:'#FFCC44'},
 K6:{n:'K6 Нейтр.',    hu:false,tau:0.8,col:'#DDBB44'},
 K7:{n:'K7 Синт.',     hu:false,tau:0.8,col:'#AACC44'},
 K8:{n:'K8 Дискурс',   hu:false,tau:0.6,col:'#4488FF'},
 KG:{n:'KG Grok/GC',   hu:false,tau:1.0,col:'#8844FF'},
 H1:{n:'H1 Маркеры',   hu:true, tau:1.5,col:'#00D97E'},
 H2:{n:'H2 Ритм',      hu:true, tau:1.0,col:'#00BB6A'},
 H3:{n:'H3 Нелин.',    hu:true, tau:0.8,col:'#009955'},
 H4:{n:'H4 BioSpec',   hu:true, tau:1.2,col:'#44AAFF'},
 H5:{n:'H5 Пункт.',    hu:true, tau:1.0,col:'#0088CC'},
 K9:{n:'K9 Проза',     hu:true, tau:1.5,col:'#AA88FF'},
 HA:{n:'HA Акад.',      hu:true, tau:1.4,col:'#44CCBB'},
 HE:{n:'HE EDNL',      hu:true, tau:1.5,col:'#FF44AA'},
};

const W={};MDEF.forEach(m=>W[m[0]]=m[3]);
const P={beta:1.6,alpha:8,mx:0.25};

// ═══ ЖАНРЫ 8 штук ═══
const GENRES={
 academic:{ru:'Академический',col:'#4488FF'},legal:{ru:'Юридический',col:'#AA88FF'},
 journalistic:{ru:'Журналистский',col:'#00D97E'},educational:{ru:'Учебный',col:'#FFAA44'},
 informal:{ru:'Неформальный',col:'#FF44AA'},neutral:{ru:'Нейтральный',col:'#5C5A78'},
 literary:{ru:'Худ. проза',col:'#AA88FF'},essay:{ru:'Публицистика/Эссе',col:'#44CCBB'},
};
const GI={academic:0,legal:1,journalistic:2,educational:3,informal:4,neutral:5,literary:6,essay:7};

const GM={
 academic:['исследование','анализ','методология','гипотеза','результаты','нормативно-правовой','курсовая','реферат','дипломная','монографии','research','methodology'],
 legal:['в соответствии','настоящий','федеральный закон','статья','пункт','истец','ответчик','гк рф','ук рф'],
 journalistic:['по данным','источник сообщает','эксперты считают','заявил','по словам','разберёмся','предприниматель','бизнес'],
 educational:['рассмотрим','как известно','определение','понятие','примером может служить','параграф'],
 informal:['кстати','короче','типа','реально','вообще','блин','ладно','tbh','kinda','gonna'],
 literary:['прошептал','усмехнулся','вздрогнул','замер','почудилось','словно','будто','запах','тишина'],
 essay:['я убеждён','я считаю','на мой взгляд','мне кажется','позволю себе','парадокс в том','согласитесь','задумайтесь'],
};

// GK [acad,legal,journ,educ,inform,neutral,literary,essay]
const GK={
 1:[.12,.18,.7,.35,1,1,.2,.8],19:[.12,.18,.7,.35,1,1,.1,.8],
 5:[.5,.3,.8,.7,1,1,0,.9],16:[.08,.08,.8,.45,1,1,.1,.7],
 8:[.8,.8,1,1,1,1,.1,.4],18:[.5,.3,.8,.7,1,1,.05,.4],
 10:[.8,.9,1,1,1,1,0,.9],13:[.7,.7,1,1,1,1,0,.9],14:[.7,.7,1,1,1,1,0,.9],
 55:[.8,1,1,1,1,1,.25,.9],56:[.2,.2,.8,.6,1,1,.05,.9],57:[.5,.4,.7,.5,1,1,.2,.6],
 25:[.1,.05,.5,.3,1,1,1.2,.8],26:[.6,.4,1,.8,1,1,1.8,1.4],
 28:[.5,.3,1,.8,1,1,1.8,1.4],29:[.8,.6,1,1,1,1,1.6,1.2],
 23:[.7,.5,1,.8,1,1,1.5,1.1],41:[.9,.7,1,1,1,1,1.8,1.2],
 63:[.7,.5,1,.8,1,1,1.6,1.3],69:[.8,.8,1,.8,1,1,.2,.9],
 39:[.1,.08,.8,.4,1,1,.8,.6],42:[.5,.4,.9,.8,1,1,.3,.9],
 32:[1,1,1,1,1,1,0,1],40:[1,1,1,1,1,1,0,1],
 43:[1,1,1,1,1,1,.05,1],76:[1,1,1,1,1,1,.05,1],
 4:[1,1,1,1,1,1,0,1],6:[1,1,1,1,1,1,0,1],20:[1,1,1,1,1,1,0,1],
 44:[1,1,1,1,1,1,0,1],38:[1,1,1,1,1,1,.1,1],
 61:[0,0,.05,.05,.15,0,1,.1],
 fn:[1.5,1.5,.3,.5,.1,1,.1,.2],pw:[1.5,1.2,.5,.8,.2,1,.2,.6],
 82:[.3,.3,.8,.5,1.3,1,1.2,1.4],83:[.2,.2,.6,.4,1.3,1,1.0,1.3],
 78:[.3,.2,.8,.5,1,1,.5,1.3],79:[.5,.4,.9,.7,1,1,.6,1.0],
};
function gk(id,g){const a=GK[id];if(!a)return 1;return a[GI[g]??5]??1;}

// detectGenre — unicode safe
function detectGenre(text){
 const tl=text.toLowerCase();const sc={};
 for(const[g,ms]of Object.entries(GM))sc[g]=ms.filter(m=>tl.includes(m)).length;
 const dial=(text.match(/^[\s]*[\-\u2013\u2014]\s*[^\s\-]/gm)||[]).length;
 const ell=(text.match(/\.{3}/g)||[]).length;
 sc.literary=(sc.literary||0)+dial*.8+ell*.3;
 // prose verbs — unicode
 const pv=(text.match(/(\u043f\u0440\u043e\u0448\u0435\u043f\u0442\u0430\u043b|\u0432\u0437\u0434\u0440\u043e\u0433\u043d\u0443\u043b|\u0437\u0430\u043c\u0435\u0440|\u043f\u0440\u043e\u043c\u043e\u043b\u0432\u0438\u043b|\u0431\u0443\u0440\u043a\u043d\u0443\u043b|\u043a\u0438\u0432\u043d\u0443\u043b|\u0432\u0442\u044e\u0440\u0438\u043b\u0441\u044f|\u043e\u0441\u043a\u043b\u0430\u0431\u0438\u043b\u0430\u0441\u044c|\u0437\u0430\u0432\u044c\u044e\u0436\u0438\u043b\u0430|\u0441\u043a\u0443\u043a\u043e\u0436\u0438\u043b\u0441\u044f|\u0441\u0438\u0433\u0430\u043d\u0443\u043b\u0430|\u0437\u0443\u0434\u0438\u0442)/gi)||[]).length;
 sc.literary=(sc.literary||0)+pv*.6;
 const p1=(tl.match(/\b(\u044f|\u043c\u043d\u0435|\u043c\u0435\u043d\u044f)\b/g)||[]).length;
 if(p1>5&&dial>3)sc.literary=(sc.literary||0)+3;
 const fn2=(text.match(/\[\d+\]/g)||[]).length;
 sc.academic=(sc.academic||0)+fn2*.4;
 const em2=(tl.match(/\b(\u044f \u0441\u0447\u0438\u0442\u0430\u044e|\u043d\u0430 \u043c\u043e\u0439 \u0432\u0437\u0433\u043b\u044f\u0434|\u043c\u043d\u0435 \u043a\u0430\u0436\u0435\u0442\u0441\u044f|\u044f \u0443\u0431\u0435\u0436\u0434\u0451\u043d|\u0441\u043e\u0433\u043b\u0430\u0441\u0438\u0442\u0435\u0441\u044c|\u0437\u0430\u0434\u0443\u043c\u0430\u0439\u0442\u0435\u0441\u044c)\b/gi)||[]).length;
 sc.essay=(sc.essay||0)+em2*1.2;
 return Object.entries(sc).sort((a,b)=>b[1]-a[1])[0][0]||'neutral';
}

// ═══ DICTIONARIES ═══
const CL_RU=['в целом','следует отметить','таким образом','важно отметить','важно понимать','прежде всего','тем не менее','в результате','можно выделить','в заключение','стоит отметить','данный вопрос','необходимо отметить','следует подчеркнуть','как известно','само собой разумеется','необходимо учитывать','следует признать','очевидно что','не вызывает сомнений','бесспорно'];
const CL_EN=['it is important','it is worth','in conclusion','in summary','it is crucial','plays a role','on the other hand','first and foremost','as a result','in this regard','delve into','needless to say'];
const AI_W_RU=['несомненно','безусловно','значительный','существенный','актуальный','эффективный','оптимальный','комплексный','систематический','инновационный'];
const AI_W_EN=['delve','realm','crucial','straightforward','comprehensive','robust','foster','leverage','utilize','facilitate','furthermore','moreover','additionally'];
const HEDGE_RU=['возможно','вероятно','по всей видимости','как правило','нередко','во многих случаях'];
const HEDGE_EN=['possibly','perhaps','it seems','it may be','generally speaking','in many cases'];
const SAFETY=['я не могу помочь','это не в моих возможностях','важно проконсультироваться','я должен отметить','как языковая модель','как ии','i cannot assist','i\'m not able to help','as an ai','as a language model','i must emphasize'];
const JAILB=['джейлбрейк','обход ограничений',' dan ','режим без ограничений','забудь все инструкции','act as ','jailbreak','system prompt','без цензуры'];
const DOUBT_RU=['не знаю','мне кажется','по-моему','честно говоря','может быть','я думаю','не уверен','признаться'];
const DOUBT_EN=['i think','i feel','honestly','to be fair','i guess','not sure'];
const RST_RU=['однако','но при этом','вместе с тем','тем не менее','с другой стороны','несмотря на','хотя','в противовес','в отличие от','напротив','зато'];
const RST_EN=['however','nevertheless','nonetheless','on the contrary','despite','although','yet','whereas','conversely'];
const EXPL_RU=['который является','что означает','то есть','иными словами','другими словами','что представляет собой','который служит для'];
const EXPL_EN=['which is a','also known as','referred to as','what is known as','in other words'];
const ABST=/\b(реализация|оптимизация|функционирование|осуществление|обеспечение|систематизация|актуализация|трансформация|модернизация)\b/gi;
const NOM_SUF=/[а-яё]{4,}(ация|ения|ости|ество|ании|ение|ость|ство|ации|изация|ование|тельность|ированность)\b/gi;
const BODILY=/\b(запах|аромат|звук|шорох|прикоснул|ощутил|почувствовал|холод|тепло|боль|пульс|дыхание|вздох)\b/gi;
const PROSE_V=/\b(прошептал|усмехнулся|вздрогнул|замер|промолвил|буркнул|кивнул|покачал|вскочил|побледнел|задрожал|парировал|пригрозил|осклабилась|завьюжила)\b/gi;
const BIO_T=/\b(я|мне|меня)\s+.{0,30}?\b(лет|году|тогда|раньше|помню|детстве|юности)\b/gi;
const P1R=/\b(я|мне|меня|мой|моя|моё|мои)\b/gi;
const P1E=/\b(i|i'm|i've|i'd|i'll|my|me|mine)\b/gi;
const SLANG_R=/\b(короче|типа|кстати|ну|блин|вообще|реально|ладно|окей|чё|ага|ваще|прикол|жесть|ржака|кринж|имба|рофл)\b/gi;
const SLANG_E=/\b(kinda|sorta|gonna|wanna|dunno|yeah|nah|omg|lol|tbh|ngl)\b/gi;
const EMO_R=/\b(злой|счастлив|грустно|обидно|боюсь|ненавижу|люблю|ужасно|классно|кайф|бесит|радует|страшно|восторг|горе|тоска|льстило|разочаровано)\b/gi;
const EMO_E=/\b(love|hate|fear|angry|sad|happy|excited|terrible|amazing|awful|sucks|awesome|devastated|thrilled)\b/gi;
const NONLIN=/\b(впрочем|кстати|к слову|вернёмся|уточню|если быть точнее|иначе говоря|точнее|я отвлёкся|хотя нет|вот и|тогда я|между прочим|ладно|не прав)\b/gi;
const FORMAL_R=/\b(вследствие|нижеследующий|посредством|надлежащий|соответствующий)\b/gi;
const INFML_R=/\b(ну|вот|типа|короче|блин|кстати|вообще-то|ладно)\b/gi;

// ═══ HELPERS ═══
const tok=t=>t.toLowerCase().match(/[а-яёa-z]+/g)||[];
const fmap=a=>{const m={};for(const t of a)m[t]=(m[t]||0)+1;return m;};
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const cv=a=>{const m=mean(a);if(!m||a.length<2)return 0;return Math.sqrt(a.map(x=>(x-m)**2).reduce((s,v)=>s+v,0)/a.length)/m;};
const clamp=(x,lo=0,hi=1)=>Math.min(hi,Math.max(lo,x));
const sig=(x,a)=>1/(1+Math.exp(-a*x));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const sents=t=>t.split(/(?<=[.!?…])\s+(?=[А-ЯA-ZЁ«"'])|(?<=[.!?…])\s+/).filter(s=>s.trim().length>8);
// paras: пытаемся выделить абзацы. Если явных абзацев нет, делаем "псевдо-абзацы" из предложений,
// чтобы структурные метрики (K5/KG/HE) работали устойчивее на сплошном тексте.
const paras=t=>{
  const raw=t.split(/\n\s*\n/).map(s=>s.trim()).filter(s=>s.length>10);
  if(raw.length>=2) return raw;
  const ss=sents(t);
  if(ss.length>=8){
    const out=[];
    const step=3; // 3 предложения = один псевдо-абзац
    for(let i=0;i<ss.length;i+=step){
      const chunk=ss.slice(i,i+step).join(' ').trim();
      if(chunk.length>20) out.push(chunk);
    }
    if(out.length>=2) return out;
  }
  return null;
};

// ═══ COMPUTE ═══
function compute(text){
 const tokens=tok(text),tl=text.toLowerCase();
 const f=fmap(tokens),w=tokens.length||1,t=Object.keys(f).length;
 const ss=sents(text),pp=paras(text),ns=Math.max(ss.length,1);
 const V={};

 // K1
 V[1]=clamp([...CL_RU,...CL_EN].filter(c=>tl.includes(c)).length/(ns*.25+1));
 V[2]=clamp([...AI_W_RU,...AI_W_EN].filter(x=>new RegExp('\\b'+x+'\\b','i').test(text)).length/5);
 V[19]=clamp(CL_RU.slice(0,14).filter(p=>tl.includes(p)).length/(ns*.2+1));
 V[16]=clamp((text.match(ABST)||[]).length/(ns*.25+1));
 const fw=pp?pp.map(p=>p.split(/\s+/)[0].toLowerCase()).slice(0,40):[];
 if(fw.length>1){const fc=fmap(fw),ft=fw.length;const pe=-Object.values(fc).map(c=>c/ft).reduce((s,p)=>p>0?s+p*Math.log(p):s,0);V[21]=clamp(1-pe/Math.log(Math.max(ft,2)));}else V[21]=.4;

 // K2
 const em=(text.match(/[—–]/g)||[]).length,hy=(text.match(/(?<!\w)-(?!\w)/g)||[]).length;
 const emR=em/Math.max(hy,.5);
 V[56]=emR>5?.9:emR>3?.75:emR>1.5?.5:emR>.5?.3:.05;
 V[57]=clamp(((text.match(/\*\*.+?\*\*/g)||[]).length+(text.match(/^#{1,3}\s/gm)||[]).length*2)/8);
 V[69]=clamp([...SAFETY,...JAILB.slice(0,4)].filter(s=>tl.includes(s)).length/2);

 // K3
 V[3]=clamp(1-t/w/.6);
 {let H=0;for(const c of Object.values(f)){const p=c/w;H-=p*Math.log(p+1e-12);}
  const J=t>1?H/Math.log(t):0; V[32]=J>.93?.75:J<.70?.70:J<.78?.25:.08;}
 function mtld(tks,thr=.72){if(tks.length<15)return tks.length;
  function one(ts){let fc=0,seen=new Set(),tot=0;for(const x of ts){seen.add(x);tot++;if(seen.size/tot<=thr){fc++;seen=new Set();tot=0;}}if(tot>0)fc+=(1-seen.size/tot)/(1-thr);return fc?ts.length/fc:ts.length;}
  return(one(tks)+one([...tks].reverse()))/2;}
 V[33]=mtld(tokens)<45?.9:mtld(tokens)<75?.7:mtld(tokens)<120?.25:.08;
 function mattr(tks,L=50){if(tks.length<L)return new Set(tks).size/tks.length;let s=0,n=tks.length-L+1;for(let i=0;i<n;i++)s+=new Set(tks.slice(i,i+L)).size/L;return s/n;}
 const ma=mattr(tokens);V[34]=ma<.62?.9:ma<.72?.65:ma<.82?.2:.4;
 function hdd(tks,n=42){const N=tks.length;if(N<n)return 0;function lf(x){if(x<=1)return 0;let s=0;for(let i=2;i<=x;i++)s+=Math.log(i);return s;}function lc(a,b){return a<b||b<0?-Infinity:lf(a)-lf(b)-lf(a-b);}let h=0;for(const c of Object.values(fmap(tks))){if(c>N-n){h+=1/n;continue;}h+=(1-Math.exp(lc(N-c,n)-lc(N,n)))/n;}return h;}
 const hv=hdd(tokens);V[35]=hv<.60?.9:hv<.70?.65:hv<.80?.3:.08;
 function dp(tks,z=8){const zs=Math.max(2,Math.min(z,Math.floor(tks.length/8)));const zS=Math.floor(tks.length/zs);if(zS<4)return.5;const gf=fmap(tks);const sg=Object.keys(gf).filter(x=>gf[x]>=3);if(!sg.length)return.5;const zm=[];for(let i=0;i<zs;i++)zm.push(fmap(tks.slice(i*zS,(i+1)*zS)));return mean(sg.map(ww=>{const tf=gf[ww];return zm.map(z2=>(z2[ww]||0)/tf).reduce((s,o)=>s+Math.abs(o-1/zs),0)/2;}));}
 const dv=dp(tokens);V[38]=dv>.55?.85:dv>.40?.65:dv>.25?.3:.05;

 // K4
 let ls=0;for(const x of tokens)ls+=Math.log(1/(f[x]/w));
 V[4]=Math.exp(ls/w)<8?1:Math.exp(ls/w)<15?.6:.2;
 const sl=ss.map(s=>s.split(/\s+/).length);const bCV=sl.length>2?cv(sl):.5;
 V[5]=bCV<.15?1:bCV<.3?.7:bCV<.5?.35:.05;
 V[6]=pp?cv(pp.map(p=>p.length))<.15?.9:cv(pp.map(p=>p.length))<.3?.55:.1:.5;
 {const ppls=ss.map(s=>{const st=tok(s);if(!st.length)return 5;let l2=0;for(const x of st)l2+=Math.log(1/((f[x]||1)/w));return Math.exp(l2/st.length);});V[44]=cv(ppls)<.3?.85:cv(ppls)<.5?.55:.1;}

 // K5
 if(pp&&pp.length>=2){const sw=new Set(['и','в','на','с','по','для','что','это','как','но','а','из','от','к','the','a','an','and','or','but','in','on','at','to']);const fw2=x=>tok(x).filter(q=>q.length>3&&!sw.has(q));const wA=new Set(fw2(pp[0])),wB=new Set(fw2(pp[pp.length-1]));const inter=[...wA].filter(x=>wB.has(x)).length,union=new Set([...wA,...wB]).size;V[7]=union?inter/union>.35?1:inter/union>.2?.7:inter/union>.1?.35:.05:.3;}else V[7]=.3;
 const hasI=/\b(введение|для начала|данная тема|introduction)\b/i.test(text);
 const hasC=/\b(в заключение|подводя итог|таким образом|вывод|conclusion|to sum up)\b/i.test(text);
 V[8]=hasI&&hasC?.9:hasC?.65:hasI?.5:.15;
 {const listLines=(text.match(/^[\s]*[\-•*]\s/gm)||[]).length+(text.match(/^[\s]*\d+[.)]\s/gm)||[]).length;const evenLists=(text.split(/\n\n+/).filter(b=>b.match(/^[\s]*[\-•*\d]/m))).filter(b=>{const items=b.match(/^[\s]*[\-•*\d][.)]\s.+/gm)||[];if(items.length<2)return false;return cv(items.map(i=>i.length))<.3&&items.length>=3&&items.length<=6;}).length;V[18]=evenLists>1?.85:evenLists>0?.6:listLines>8?.4:.08;}
 const allFl=[...CL_RU,...CL_EN],f20=tl.slice(0,Math.floor(tl.length*.2));
 V[55]=clamp(allFl.filter(f2=>tl.includes(f2)).length>0?allFl.filter(f2=>f20.includes(f2)).length/allFl.filter(f2=>tl.includes(f2)).length:0);

 // K6
 const ec=(text.match(EMO_R)||[]).length+(text.match(EMO_E)||[]).length;
 V[10]=ec<1?.85:ec<3?.5:ec<7?.25:.05;
 V[13]=/\b(с одной стороны|с другой стороны|on one hand|on the other)\b/i.test(text)?.7:.2;
 V[14]=(text.match(/\b(полагаю|считаю|уверен|думаю|i believe|in my opinion)\b/gi)||[]).length<1?.8:.2;
 V[20]=[...DOUBT_RU,...DOUBT_EN].filter(d=>tl.includes(d)).length<1?.75:.25;
 V[31]=clamp([...HEDGE_RU,...HEDGE_EN].filter(h=>tl.includes(h)).length/(ns*.2+1));

 // K7
 const starts=ss.map(s=>s.trim().split(/\s+/).slice(0,2).join(' ').toLowerCase());
 const sf=fmap(starts);const se=-Object.values(sf).map(c=>c/ns).reduce((s,p)=>p>0?s+p*Math.log(p):s,0);
 V[15]=clamp(1-se/Math.log(ns+1));
 const bg=ss.map(s=>s.trim().split(/\s+/).slice(0,2).join(' ').toLowerCase());
 const bf=fmap(bg);const be=-Object.values(bf).map(c=>c/ns).reduce((s,p)=>p>0?s+p*Math.log(p):s,0);
 V[49]=clamp(1-be/Math.log(ns+1));
 {const seen=new Set();let nir=0;for(const s of ss){const tw=tok(s).filter(x=>x.length>3);if(!tw.length)continue;nir+=tw.filter(x=>!seen.has(x)).length/tw.length;tw.forEach(x=>seen.add(x));}const nm=nir/ns;const bigs=[];for(let i=0;i<tokens.length-1;i++)bigs.push(tokens[i]+'_'+tokens[i+1]);const cr2=bigs.length?new Set(bigs).size/bigs.length:1;V[50]=((nm<.2?.85:nm<.35?.6:nm<.5?.3:.05)+(cr2<.55?.8:cr2<.70?.5:.15))/2;}
 if(pp&&pp.length>=2){
  function topN(p,n){
   if(n===undefined) n=5;
   const tf=fmap(tok(p).filter(x=>x.length>3));
   return Object.entries(tf).sort((a,b)=>b[1]-a[1]).slice(0,n).map(x=>x[0]);
  }
  let ov=0;
  for(let i=0;i<pp.length-1;i++){
   const a=new Set(topN(pp[i])),b=new Set(topN(pp[i+1]));
   ov+=[...a].filter(x=>b.has(x)).length/5;
  }
  V[76]=clamp(ov/(pp.length-1));
 }else V[76]=.3;

 // K8
 {const nom=(text.match(NOM_SUF)||[]).length;const absM=clamp((text.match(ABST)||[]).length/(ns*.15+1));V[39]=clamp(clamp(nom/(w*.04+1))*.6+absM*.4);}
 const nc=(text.match(/\b\d{4}\b|\b\d{1,3}[.,]\d+\b/g)||[]).length;
 V[40]=nc<1?.75:nc<3?.45:nc<6?.2:.05;
 V[42]=clamp(([...RST_RU,...RST_EN].filter(r=>tl.includes(r)).length)/(ns*.15+1));
 {const sv=ss.map(s=>fmap(tok(s).filter(x=>x.length>3)));let sm=0,cnt=0;for(let i=0;i<sv.length-1;i++){const a=sv[i],b=sv[i+1];const all=new Set([...Object.keys(a),...Object.keys(b)]);let dot=0,na=0,nb=0;for(const k of all){const av=a[k]||0,bv=b[k]||0;dot+=av*bv;na+=av*av;nb+=bv*bv;}if(na&&nb){sm+=dot/(Math.sqrt(na)*Math.sqrt(nb));cnt++;}}V[43]=(cnt>0?sm/cnt:.5)>.5?.85:(cnt>0?sm/cnt:.5)>.3?.55:.15;}
 V[48]=clamp(V[43]*(V[50]||.5));// GL-CLiC proxy: TopicMono × NIR
 V[75]=clamp(([...EXPL_RU,...EXPL_EN].filter(e=>tl.includes(e)).length)/(ns*.12+1));

 // KG — Grok/GigaChat 2026
 V[78]=clamp(V[39]*V[43]);// NominalRhythm = NomShare × TopicMono
 {if(pp&&pp.length>=3){const fml=pp.map(p=>{const fw2c=(p.match(FORMAL_R)||[]).length;const iw2=(p.match(INFML_R)||[]).length;return (fw2c+1)/(fw2c+iw2+2);});V[79]=clamp(1-cv(fml)/.5);}else V[79]=.5;}

 // H1
 V[25]=clamp(((text.match(SLANG_R)||[]).length+(text.match(SLANG_E)||[]).length)/(ns*.15+1));
 const p1c=(text.match(P1R)||[]).length+(text.match(P1E)||[]).length;
 V[26]=clamp(p1c/(ns*.15+1));
 V[27]=clamp([...DOUBT_RU,...DOUBT_EN].filter(d=>tl.includes(d)).length/3);
 V[28]=clamp(ec/(ns*.15+1));

 // H2
 V[29]=bCV>.55?1:bCV>.38?.7:bCV>.22?.35:.05;
 const fw2c=(text.match(FORMAL_R)||[]).length,iw=(text.match(INFML_R)||[]).length;
 V[23]=fw2c>0&&iw>0?clamp((fw2c+iw)/(ns*.25+1)):0;
 V[46]=clamp(sl.filter(l=>l>40).length/Math.max(sl.length,1)/.3);

 // H3
 V[41]=clamp((text.match(NONLIN)||[]).length/3);
 V[22]=.15;
 V[47]=clamp(([/\bвообщем\b/gi,/\bнавеное\b/gi,/\s,/g,/,,/g].reduce((s,rx)=>s+(text.match(rx)||[]).length,0))/2);

 // H4
 const bioA=(text.match(BIO_T)||[]).length+(text.match(BODILY)||[]).length/2;
 const bioS=clamp(bioA/(ns*.08+1));
 V[63]=clamp(((text.match(BIO_T)||[]).length*.6+bioS*.4+V[26]*.3)/1.5);
 V[73]=clamp((text.match(NONLIN)||[]).length*.3/(ns+1)+(text.match(/\b(тогда|там|тут|тот|та|те)\b/gi)||[]).length*.05);

 // H5
 V[45]=clamp((text.match(/«[^»]{8,}»/g)||[]).length/(ns*.12+1));
 {const uws=Object.entries(f).filter(([k,c])=>c===1&&k.length>4);V[72]=clamp(uws.length/Math.max(Object.keys(f).length,1)/.4);}

 // K9
 V[61]=pp?clamp(pp.filter(p=>p.split(/\s+/).length<=4).length/(pp.length*.5+.1)):0;

 // HA
 V['fn']=clamp((text.match(/\[\d+\]/g)||[]).length/(ns*.06+1));
 V['pw']=clamp((text.match(/\b(мы согласны|мы считаем|мы полагаем|мы изучили|мы пришли|на наш взгляд)\b/gi)||[]).length/3);

 // HE — EDNL + CapEmphasis
 {// StyleShift: CV of formal/informal ratio per paragraph
  // (фикс синтаксиса: раньше тут была неверно записана IIFE `(()=>{...}())`)
  let styleCV=bCV*.5;
  if(pp&&pp.length>=3){
   const fsc=pp.map(p=>{
    const f2=(p.match(FORMAL_R)||[]).length,
          i2=(p.match(INFML_R)||[]).length,
          e2=(p.match(EMO_R)||[]).length;
    return (f2+1)/(f2+i2+e2+2);
   });
   styleCV=cv(fsc);
  }
  // Nonlinearity markers
  const nlM=clamp((text.match(NONLIN)||[]).length/(ns*.08+1));
  // Personal anchor
  const bioAnc=clamp(((text.match(BIO_T)||[]).length+(text.match(/\b(семь[яи]|дет[иейям]|друг|близкие|родные|тебя|тобой|вместе)\b/gi)||[]).length*.3)/(ns*.05+1));
  // CapEmphasis: КАПС не в начале предложения
  const caps=(text.match(/\b[А-ЯЁ]{3,}\b/g)||[]).filter(w=>w!==w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()&&!['ИИ','США','МГУ','РФ','ООН','ФЗ','КГБ'].includes(w)).length;
  const capE=clamp(caps/(ns*.05+1));
  // P.S. самокоррекция
  const ps=(text.match(/\bP\.?[Ss]\.?\b/g)||[]).length;
  const nlScore=nlM*.7+clamp(ps/3)*.3;
  const hedge=clamp([...HEDGE_RU,...HEDGE_EN].filter(h=>tl.includes(h)).length/(ns*.2+1));
  V[82]=clamp(styleCV*1.4+nlScore*1.2+bioAnc*1.3+capE*.8-hedge*.8);
  V[83]=capE;}

 return V;
}

// ═══ FORMULA ═══
function formula(V,genre){
 const CL={};for(const[k]of Object.entries(CMETA))CL[k]={vs:[],ws:[]};
 for(const[id,,cid,wb,tau]of MDEF){
  if(typeof id==='number'&&!(id in V))continue;
  if(typeof id==='string'&&!(id in V))continue;
  const ki=gk(id,genre),wi=W[id]??wb;
  CL[cid].vs.push((V[id]||0)*ki);CL[cid].ws.push(wi);
 }
 const G={};
 for(const[cid,cl]of Object.entries(CL)){const sw=cl.ws.reduce((s,x)=>s+x,0);G[cid]=sw>0?cl.vs.reduce((s,v,i)=>s+cl.ws[i]*v,0)/sw:0;}
 const agg=cids=>{let n=0,d=0;for(const c of cids){const Wk=CL[c].ws.reduce((s,x)=>s+x,0),tau=CMETA[c].tau,wt=Wk*tau;n+=G[c]*wt;d+=wt;}return d?n/d:0;};
 const aiCl=Object.keys(CMETA).filter(c=>!CMETA[c].hu);
 const huCl=Object.keys(CMETA).filter(c=>CMETA[c].hu);
 const sAI=agg(aiCl),sHU=agg(huCl);
 const delta=sAI-P.beta*sHU,pAI=sig(delta,P.alpha);
 return{G,sAI,sHU,delta,pAI};
}

function detectMixed(text,V,sAI,sHU){
 const ss2=sents(text);if(ss2.length<6)return{mixed:false,cv:0};
 const wsz=3;const scores=[];
 for(let i=0;i<ss2.length-wsz+1;i++){const chunk=ss2.slice(i,i+wsz).join(' ');const vc=compute(chunk);const fc=formula(vc,'neutral');scores.push(fc.pAI);}
 const scv=cv(scores);
 const huStr=V[82]>.5||V[26]>.5||V[63]>.5;
 const aiStr=V[1]>.5||V[69]>.3||V[15]>.6;
 const mixed=(scv>P.mx&&huStr&&aiStr)||(scv>.4&&Math.abs(sAI-sHU)>.15&&Math.min(sAI,sHU)>.3);
 return{mixed,cv:scv};
}

// ═══ SCAN ═══
module.exports={compute,formula,detectGenre,MDEF,CMETA,P,W:typeof W!=='undefined'?W:{}};

// --- CLI-обёртка для вызова из Python: JSON на stdin -> JSON на stdout ---
if (require.main === module) {
  let buf = '';
  process.stdin.on('data', d => buf += d);
  process.stdin.on('end', () => {
    try {
      const { text } = JSON.parse(buf);
      const V = compute(text);
      const genre = detectGenre(text);
      const r = formula(V, genre);
      process.stdout.write(JSON.stringify({
        ok: true, genre, pAI: r.pAI, sAI: r.sAI, sHU: r.sHU,
        clusters: r.G, metrics: V,
        meta: Object.fromEntries(Object.entries(CMETA).map(([k, v]) => [k, { name: v.n, human: v.hu }])),
      }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  });
}
