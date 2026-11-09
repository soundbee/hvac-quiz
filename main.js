import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, remove, onValue, onDisconnect, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const isTeacher = document.body.dataset.role === 'teacher';
const $ = id => document.getElementById(id);
const DURATION = 15000;
const CHOICE_LABELS = ['①', '②', '③', '④'];
const userFacingError = err => {
  const code = String(err?.code || '');
  if (code.includes('permission-denied')) return '접근이 거부되었습니다. 교수자 UID를 Firebase 규칙에 등록했는지, 수업 입장/응답 시간이 유효한지 확인하세요.';
  if (code.includes('invalid-credential') || code.includes('wrong-password')) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (code.includes('network')) return '연결 상태를 확인하고 다시 시도해 주세요.';
  if (code.includes('operation-not-allowed')) return 'Firebase Authentication에서 이메일/비밀번호 및 익명 로그인을 활성화해야 합니다.';
  return String(err?.message || err || '알 수 없는 오류가 발생했습니다.');
};
function report(message, role=isTeacher?'teacher':'student') {
  const el = $(role + 'Error');
  if (!el) { console.error(message); return; }
  el.textContent = message; el.classList.remove('hidden');
}
function clearError(role=isTeacher?'teacher':'student'){const el=$(role+'Error');if(el)el.classList.add('hidden');}
function show(el, yes){if(typeof el==='string')el=$(el); if(el)el.classList.toggle('hidden',!yes);}
function txt(el,value){if(typeof el==='string')el=$(el);if(el)el.textContent=String(value ?? '');}
function empty(el){if(typeof el==='string')el=$(el);while(el?.firstChild)el.removeChild(el.firstChild);}
function node(tag,className,content){const el=document.createElement(tag);if(className)el.className=className;if(content!==undefined)el.textContent=String(content);return el;}
function pad(n){return String(n).padStart(2,'0');}
function serverMs(){return Date.now()+offsetMs;}
function position(pub){
  if(!pub||pub.phase!=='running'||!Number(pub.startAt))return {index:-1,left:0,ended:false};
  const n=Number(pub.questionCount)||10;
  const duration=Number(pub.durationMs)||DURATION;
  const elapsed=Math.max(0,serverMs()-Number(pub.startAt));
  const i=Math.floor(elapsed/duration);
  return {index: Math.min(n-1,i),left:Math.max(0,duration-(elapsed%duration)),ended:i>=n};
}
function setTimer(clock,bar,left,duration){
  const sec=Math.max(0,left/1000);
  txt(clock,sec.toFixed(1)+'초');
  $(clock)?.classList.toggle('urgent',sec<5);
  if($(bar))$(bar).style.width=(100*Math.max(0,Math.min(1,left/duration)))+'%';
}
function csvSafe(v){let s=String(v??''); if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
function downloadCSV(rows,filename){
  const s='\ufeff'+rows.map(r=>r.map(csvSafe).join(',')).join('\r\n');
  const u=URL.createObjectURL(new Blob([s],{type:'text/csv;charset=utf-8;'}));
  const a=document.createElement('a');a.href=u;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(u),30000);
}
async function copy(value){try{await navigator.clipboard.writeText(value);return true;}catch(_){return false;}}
function codeFromUrl(){return new URL(location.href).searchParams.get('code')?.replace(/\D/g,'').slice(0,6) || '';}
function quizLink(code){const u=new URL('index.html',location.href);u.searchParams.set('code',code);return u.href;}
function screenLink(code){const u=new URL('display.html',location.href);u.searchParams.set('code',code);return u.href;}
function isConfigured(){return firebaseConfig.apiKey && !String(firebaseConfig.apiKey).includes('PASTE_') && firebaseConfig.databaseURL && !String(firebaseConfig.databaseURL).includes('PASTE_');}

let app, db, auth, offsetMs=0;
if(!isConfigured())report('Firebase 설정이 아직 입력되지 않았습니다. site/firebase-config.js에 자신의 Firebase 웹 앱 설정을 넣어주세요.');
else {
  try {
    // 학생용 Firebase 앱을 별도 이름으로 초기화합니다.
    // Firebase Auth의 브라우저 로그인 상태는 앱 이름별로 분리되므로,
    // 같은 Chrome의 다른 탭에서 학생이 익명 로그인해도 교수자 로그인이 유지됩니다.
    app=isTeacher ? initializeApp(firebaseConfig) : initializeApp(firebaseConfig, 'hvac-quiz-student-v2-1');
    db=getDatabase(app);auth=getAuth(app);
    onValue(ref(db,'.info/serverTimeOffset'),s=>{offsetMs=Number(s.val())||0;});
    if(isTeacher)initTeacher();else initStudent();
  } catch(err){report('Firebase 시작 오류: '+userFacingError(err));}
}

// --------- 엑셀 읽기: ZIP 중앙 디렉터리 + 브라우저 내장 Deflate ---------
const u16=(v,o)=>v.getUint16(o,true),u32=(v,o)=>v.getUint32(o,true);
function zipIndex(buffer){
  const v=new DataView(buffer),b=new Uint8Array(buffer);
  let eocd=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(u32(v,i)===0x06054b50){eocd=i;break;}}
  if(eocd<0)throw new Error('유효한 .xlsx 파일이 아닙니다 (ZIP 디렉터리를 찾을 수 없음).');
  const n=u16(v,eocd+10), start=u32(v,eocd+16), entries={};let p=start;
  for(let i=0;i<n;i++){
    if(u32(v,p)!==0x02014b50)throw new Error('손상된 엑셀 ZIP입니다.');
    const method=u16(v,p+10),size=u32(v,p+20),nl=u16(v,p+28),extra=u16(v,p+30),comment=u16(v,p+32),offset=u32(v,p+42);
    const name=new TextDecoder().decode(b.slice(p+46,p+46+nl));entries[name]={method,size,offset};p+=46+nl+extra+comment;
  }
  return {v,b,entries};
}
async function zippedText(zip,path){
  const f=zip.entries[path];if(!f)throw new Error(path+' 파일을 엑셀 내부에서 찾을 수 없습니다.');
  const off=f.offset,v=zip.v,b=zip.b;
  if(u32(v,off)!==0x04034b50)throw new Error('잘못된 ZIP 파일입니다.');
  const p=off+30+u16(v,off+26)+u16(v,off+28);
  const comp=b.slice(p,p+f.size);
  if(f.method===0)return new TextDecoder().decode(comp);
  if(f.method!==8)throw new Error('지원하지 않는 압축 방식입니다.');
  if(!('DecompressionStream' in window))throw new Error('이 브라우저는 엑셀 압축해제를 지원하지 않습니다. JSON 파일을 사용해 주세요.');
  const stream=new Blob([comp]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
function parseXML(text){const d=new DOMParser().parseFromString(text,'application/xml');if(d.getElementsByTagName('parsererror').length)throw new Error('엑셀 XML 형식이 손상되었습니다.');return d;}
function parseCells(xml,strings){
  const data={};for(const c of xml.getElementsByTagNameNS('*','c')){
    const at=c.getAttribute('r')||'';const m=at.match(/^([A-Z]+)(\d+)$/);if(!m)continue;
    let ci=0;for(const k of m[1])ci=ci*26+k.charCodeAt(0)-64;
    const t=c.getAttribute('t')||'';let value;
    if(t==='inlineStr'){value=Array.from(c.getElementsByTagNameNS('*','t')).map(x=>x.textContent).join('');}
    else{const v=c.getElementsByTagNameNS('*','v')[0]?.textContent??'';value=t==='s'?(strings[Number(v)]??''):(t==='str'?v:(v.trim()===''?'':Number(v)));}
    (data[Number(m[2])]??=[])[ci-1]=value;
  }return data;
}
async function parseExcel(file){
  const zip=zipIndex(await file.arrayBuffer());
  const strings=[];
  if(zip.entries['xl/sharedStrings.xml']){
    const x=parseXML(await zippedText(zip,'xl/sharedStrings.xml'));
    for(const si of x.getElementsByTagNameNS('*','si'))strings.push(Array.from(si.getElementsByTagNameNS('*','t')).map(t=>t.textContent).join(''));
  }
  const sheets=Object.keys(zip.entries).filter(s=>/^xl\/worksheets\/sheet\d+\.xml$/.test(s)).sort((a,b)=>Number(a.match(/sheet(\d+)/)[1])-Number(b.match(/sheet(\d+)/)[1]));
  if(!sheets.length)throw new Error('엑셀에서 문제 시트를 찾지 못했습니다.');
  const rows=parseCells(parseXML(await zippedText(zip,sheets[0])),strings);
  const list=[];
  for(let i=4;i<=Math.max(100,...Object.keys(rows).map(Number));i++){
    const r=rows[i]||[];if(!r[3])continue;
    if(!r[4]||!r[5]||!r[6]||!r[7])throw new Error(i+'행의 보기 ①~④가 비어 있습니다.');
    if(![1,2,3,4].includes(Number(r[8])))throw new Error(i+'행의 정답번호가 올바르지 않습니다.');
    list.push({id:list.length+1,type:String(r[1]||'객관식'),box:String(r[2]||''),question:String(r[3]),options:[4,5,6,7].map(c=>String(r[c])),answer:Number(r[8])-1,explanation:String(r[10]||''),duration:15,source:String(r[12]||'')});
  }
  return {title:'공기조화설비 신입사원 핵심퀴즈',questions:list};
}
async function readQuizFile(file){
  if(!file)throw new Error('문항 파일을 선택해 주세요.');
  let obj;
  if(/\.xlsx$/i.test(file.name))obj=await parseExcel(file);
  else if(/\.json$/i.test(file.name))obj=JSON.parse(await file.text());
  else throw new Error('xlsx 또는 json 파일을 선택해 주세요.');
  if(!Array.isArray(obj?.questions)||obj.questions.length<1||obj.questions.length>50)throw new Error('문항 수는 1~50개여야 합니다.');
  const questions=obj.questions.map((q,i)=>{
    const options=q.options;
    if(!String(q.question||'').trim()||!Array.isArray(options)||options.length!==4 || options.some(x=>!String(x||'').trim()))throw new Error((i+1)+'번 문항의 질문 또는 보기를 확인하세요.');
    if(!Number.isInteger(q.answer)||q.answer<0||q.answer>3)throw new Error((i+1)+'번 문항의 정답(0~3)을 확인하세요.');
    return {id:i+1,box:String(q.box||''),question:String(q.question),options:options.map(String),answer:q.answer,explanation:String(q.explanation||''),type:String(q.type||'객관식')};
  });
  return {title:String(obj.title||'신입사원 실시간 퀴즈').slice(0,100),questions};
}

// --------- 교육생 ---------
function initStudent(){
  const c=codeFromUrl();if(c)txt('joinCode',c);
  let sessionCode='',uid='',pub=null,myRecord=null,currentIndex=-99,loadedIndex=-99,submitting=false,currentQuestion=null,unsubs=[],timer=null;
  let cachedResponses={};
  const activate=which=>['studentJoin','studentLobby','studentQuiz','studentDone','studentResult'].forEach(id=>show(id,id===which));
  $('joinForm').addEventListener('submit',async e=>{
    e.preventDefault();clearError('student');$('joinBtn').disabled=true;
    try{
      const code=$('joinCode').value.trim(),name=$('joinName').value.trim();
      if(!/^\d{6}$/.test(code))throw new Error('수업코드 6자리를 입력하세요.');
      if(!name)throw new Error('교육번호 또는 이름을 입력하세요.');
      // 로그인 정보 복원이 끝난 뒤 확인해야 새로고침/재접속 시 익명 UID가 유지됩니다.
      await auth.authStateReady();
      let user=auth.currentUser;
      if(!user||!user.isAnonymous)user=(await signInAnonymously(auth)).user;
      uid=user.uid;
      const info=(await get(ref(db,`sessions/${code}/public`))).val();
      if(!info)throw new Error('존재하지 않는 수업코드입니다.');
      const prior=(await get(ref(db,`sessions/${code}/participants/${uid}`))).val();
      if(info.phase!=='lobby'&&!prior)throw new Error('이미 시작된 수업에는 새로 입장할 수 없습니다.');
      sessionCode=code;
      if(!prior)await set(ref(db,`sessions/${code}/participants/${uid}`),{name,ready:false,joinedAt:serverTimestamp()});
      const presence=ref(db,`sessions/${code}/presence/${uid}`);
      await onDisconnect(presence).remove();await set(presence,true);
      txt('lobbyCode',code);txt('lobbyName',prior?.name||name);history.replaceState(null,'',quizLink(code));
      for(const u of unsubs)u();unsubs=[];
      unsubs.push(onValue(ref(db,`sessions/${code}/public`),s=>{pub=s.val();route();},e=>report(userFacingError(e),'student')));
      unsubs.push(onValue(ref(db,`sessions/${code}/participants/${uid}`),s=>{myRecord=s.val();updateReady();},e=>report(userFacingError(e),'student')));
      unsubs.push(onValue(ref(db,`sessions/${code}/responses/${uid}`),s=>{cachedResponses=s.val()||{};if(pub?.phase==='running')route();},e=>report(userFacingError(e),'student')));
      if(timer)clearInterval(timer);timer=setInterval(route,100);
      activate('studentLobby');route();
    }catch(err){report(userFacingError(err),'student');}finally{$('joinBtn').disabled=false;}
  });
  $('readyBtn').addEventListener('click',async()=>{
    $('readyBtn').disabled=true;clearError('student');
    try{await update(ref(db,`sessions/${sessionCode}/participants/${uid}`),{ready:true});}
    catch(err){report(userFacingError(err),'student');$('readyBtn').disabled=false;}
  });
  function updateReady(){const ready=Boolean(myRecord?.ready);txt('readyState',ready?'준비완료! 교수자의 시작을 기다립니다.':'준비가 되면 버튼을 눌러주세요.');$('readyState').classList.toggle('ready',ready);$('readyBtn').disabled=ready;txt('readyBtn',ready?'✓ 준비완료':'준비완료');}
  function route(){
    if(!pub||!sessionCode)return;
    if(pub.phase==='lobby'){activate('studentLobby');updateReady();return;}
    if(pub.phase==='revealed'){activate('studentResult');showResults();return;}
    if(pub.phase==='finished'){activate('studentDone');return;}
    const pos=position(pub);
    if(pos.ended){activate('studentDone');return;}
    activate('studentQuiz');
    const i=pos.index;
    setTimer('studentClock','studentTimerBar',pos.left,pub.durationMs||DURATION);
    txt('studentQnum',`Q ${pad(i+1)} / ${pub.questionCount}`);
    if(i!==currentIndex){currentIndex=i;loadedIndex=-99;currentQuestion=null;submitting=false;txt('studentQtitle','문제를 불러오는 중…');empty('studentOptions');show('studentQbox',false);}
    if(loadedIndex!==i && loadedIndex!==-i-1000)loadQuestion(i);
    if(cachedResponses[String(i)])showSubmitted(i);
  }
  async function loadQuestion(i){
    // 같은 문항을 동시에 여러 번 요청하지 않도록 음수 sentinel 사용
    loadedIndex=-i-1000;
    try{
      const s=await get(ref(db,`sessions/${sessionCode}/questions/${i}`));
      if(i!==currentIndex)return;
      if(!s.exists())throw new Error('아직 문제를 열 수 없습니다.');
      currentQuestion=s.val();loadedIndex=i;renderQuestion(i);
    }catch(err){
      if(i!==currentIndex)return;
      loadedIndex=-99;
      // 서버가 문항 잠금을 해제하기 직전의 시간차는 자동 재시도
      if(/permission|문제|denied/i.test(userFacingError(err))){txt('studentQtitle','문제를 불러오는 중…');return;}
      report(userFacingError(err),'student');
    }
  }
  function renderQuestion(i){
    if(!currentQuestion||i!==currentIndex)return;
    txt('studentQtitle',currentQuestion.question);
    txt('studentQbox',currentQuestion.box||'');show('studentQbox',Boolean(currentQuestion.box));
    const target=$('studentOptions');empty(target);
    (currentQuestion.options||[]).forEach((label,j)=>{
      const b=node('button','answer-option');b.type='button';b.dataset.choice=String(j);
      b.append(node('span','bubble',CHOICE_LABELS[j]),node('span','',label));
      b.addEventListener('click',()=>sendAnswer(i,j));target.append(b);
    });
    txt('studentSubmission','정답이라고 생각하는 보기를 선택하세요.');
    if(cachedResponses[String(i)])showSubmitted(i);
  }
  function showSubmitted(i){
    const ans=cachedResponses[String(i)];if(!ans)return;
    for(const b of $('studentOptions').querySelectorAll('button')){
      b.disabled=submitting;
      b.classList.toggle('selected',Number(b.dataset.choice)===Number(ans.choice));
    }
    const changed=Number(ans.changeCount||0);
    txt('studentSubmission',`선택 ${CHOICE_LABELS[ans.choice]} 저장됨 · ${changed===0?'15초 안에 변경 가능':`답안 변경 ${changed}회 · 재선택 가능`} (정오답은 종료 후 공개)`);
  }
  async function sendAnswer(i,choice){
    if(submitting||!pub||pub.phase!=='running'||position(pub).index!==i||position(pub).ended)return;
    const previous=cachedResponses[String(i)];
    if(previous&&Number(previous.choice)===choice)return;
    if(previous&&Number(previous.changeCount||0)>=20){report('문항당 답안 변경은 최대 20회입니다.','student');return;}
    submitting=true;clearError('student');
    for(const b of $('studentOptions').querySelectorAll('button'))b.disabled=true;
    txt('studentSubmission','선택을 저장하고 있습니다…');
    try{
      const answerRef=ref(db,`sessions/${sessionCode}/responses/${uid}/${i}`);
      if(!previous){
        // 최초 선택은 불변으로 기록: 최초 선택이 정답인 경우 동점자 우선순위에 반영.
        await set(answerRef,{firstChoice:choice,firstAt:serverTimestamp(),choice,submittedAt:serverTimestamp(),changeCount:0});
      }else{
        // 첫 선택/시각은 절대 수정하지 않음. 서버 규칙에서도 이를 검증함.
        await update(answerRef,{choice,submittedAt:serverTimestamp(),changeCount:Number(previous.changeCount)+1});
      }
      // 원격 구독 결과로 최종 응답을 다시 읽어 새 변경횟수와 타임스탬프 동기화.
      const actual=(await get(answerRef)).val();
      if(actual&&i===currentIndex){cachedResponses[String(i)]=actual;showSubmitted(i);}
    }catch(err){
      if(i===currentIndex)txt('studentSubmission','저장 실패 · 남은 시간 안에 다시 선택해 주세요.');
      report(userFacingError(err),'student');
    }finally{
      submitting=false;
      if(i===currentIndex&&pub?.phase==='running'&&!position(pub).ended&&position(pub).index===i){
        for(const b of $('studentOptions').querySelectorAll('button'))b.disabled=false;
        if(cachedResponses[String(i)])showSubmitted(i);
      }
    }
  }
  let showingResults=false,resultsLoaded=false;
  async function showResults(){
    if(showingResults||resultsLoaded||!sessionCode)return;showingResults=true;
    try{
      const [res,personal]=await Promise.all([get(ref(db,`sessions/${sessionCode}/results`)),get(ref(db,`sessions/${sessionCode}/personalResults/${uid}`))]);
      if(!res.exists()){showingResults=false;return;}
      const data=res.val(),mine=personal.val()||{correct:0,firstTryCorrect:0,total:Number(pub?.questionCount)||10,rank:'–',responseMs:0};
      const target=$('studentMyScore');empty(target);
      target.append(node('div','',`내 순위 ${mine.rank}위`),node('strong','',`${mine.correct} / ${mine.total}`),node('div','',`첫 선택 정답 ${mine.firstTryCorrect||0}문항 · 최종 정답 응답시간 합계 ${(mine.responseMs/1000).toFixed(2)}초`));
      drawWinners('studentWinners',data.winners||[]);
      const rev=$('studentReview');empty(rev);
      (data.review||[]).forEach((q,i)=>{
        const item=node('div','review-item');item.append(node('strong','',`Q${pad(i+1)}. ${q.question}`),node('div','correct-choice',`정답 ${CHOICE_LABELS[q.answer]} ${q.options[q.answer]}`),node('p','',q.explanation||'추가 해설 없음'));
        rev.append(item);
      });
      resultsLoaded=true;
    }catch(err){report(userFacingError(err),'student');}finally{showingResults=false;}
  }
}
function drawWinners(id,winners){
  const target=$(id);empty(target);
  if(!winners.length){target.append(node('div','muted','시상할 참여자가 없습니다.'));return;}
  winners.forEach((w,i)=>{
    const item=node('div','winner');item.append(node('span','rank',i===0?'🥇':'🥈'),node('strong','',w.name||'미등록'),node('small','',`${w.correct}개 정답 · 첫 선택 정답 ${w.firstTryCorrect||0}개 · ${(w.responseMs/1000).toFixed(2)}초`));target.append(item);
  });
}

// --------- 교수자 ---------
function initTeacher(){
  let instructor=null,quizFileData=null,code='',pub=null,questions={},answerKeys={},participants={},presence={},responses={},unsubs=[],tick=null;
  let revealed=false;
  $('loginForm').addEventListener('submit',async e=>{
    e.preventDefault();clearError('teacher');$('loginBtn').disabled=true;
    try{await signInWithEmailAndPassword(auth,$('teacherEmail').value.trim(),$('teacherPassword').value);}
    catch(err){report(userFacingError(err),'teacher');}finally{$('loginBtn').disabled=false;}
  });
  onAuthStateChanged(auth,user=>{
    const nextInstructor=user && !user.isAnonymous ? user : null;
    // 실제 로그아웃/계정 변경 시에만 이전 수업 구독을 정리합니다.
    // 익명 학생 인증은 별도 Firebase 앱에 있어 이 콜백에 영향을 주지 않습니다.
    if(instructor && instructor.uid !== nextInstructor?.uid){
      unbind();
      show('teacherRoom',false);show('teacherProgress',false);show('teacherResult',false);
    }
    instructor=nextInstructor;
    show('teacherLogin',!instructor);show('teacherApp',Boolean(instructor));show('logoutBtn',Boolean(instructor));
    if(instructor){txt('teacherUid',instructor.uid);clearError('teacher');}
  });
  $('logoutBtn').addEventListener('click',async()=>{unbind();await signOut(auth);show('teacherRoom',false);show('teacherProgress',false);show('teacherResult',false);});
  $('copyUidBtn').addEventListener('click',async()=>{if(instructor)alert(await copy(instructor.uid)?'UID를 복사했습니다.':'UID를 길게 눌러 복사하세요.');});
  $('quizFile').addEventListener('change',async e=>{
    clearError('teacher');quizFileData=null;$('createRoomBtn').disabled=true;
    try{
      quizFileData=await readQuizFile(e.target.files?.[0]);
      txt('fileSummary',`${quizFileData.questions.length}문항 읽기 완료 · 15초/문항 · 파일명: ${e.target.files[0].name}`);
      $('createRoomBtn').disabled=false;
    }catch(err){txt('fileSummary','파일을 읽지 못했습니다.');report(userFacingError(err),'teacher');}
  });
  $('createRoomBtn').addEventListener('click',async()=>{
    if(!instructor||!quizFileData)return;
    clearError('teacher');$('createRoomBtn').disabled=true;
    try{
      let c='';for(let attempts=0;attempts<12;attempts++){
        const nums=new Uint32Array(1);crypto.getRandomValues(nums);c=String(100000+(nums[0]%900000));
        if(!(await get(ref(db,`sessions/${c}/public`))).exists())break;
        c='';
      }
      if(!c)throw new Error('수업코드를 생성할 수 없습니다. 다시 시도하세요.');
      const publicQ={},keys={};
      quizFileData.questions.forEach((q,i)=>{
        publicQ[i]={id:i+1,box:q.box,question:q.question,options:q.options,offsetMs:i*DURATION};
        keys[i]={answer:q.answer,explanation:q.explanation||''};
      });
      await set(ref(db,`sessions/${c}`),{
        public:{title:quizFileData.title,phase:'lobby',durationMs:DURATION,questionCount:quizFileData.questions.length,startAt:0,createdAt:serverTimestamp()},
        questions:publicQ,answerKeys:keys
      });
      bindRoom(c);
    }catch(err){report(userFacingError(err),'teacher');}
    finally{$('createRoomBtn').disabled=false;}
  });
  $('openRoomBtn').addEventListener('click',async()=>{
    const c=$('openCode').value.replace(/\D/g,'').slice(0,6);
    if(!/^\d{6}$/.test(c)){report('기존 수업코드 6자리를 입력하세요.','teacher');return;}
    try{const s=await get(ref(db,`sessions/${c}/public`));if(!s.exists())throw new Error('존재하지 않는 수업코드입니다.');bindRoom(c);}
    catch(err){report(userFacingError(err),'teacher');}
  });
  $('copyLinkBtn').addEventListener('click',async()=>{
    const url=quizLink(code);alert(await copy(url)?'교육생 링크를 복사했습니다.':'위 링크를 길게 눌러 복사하세요.');
  });
  $('startBtn').addEventListener('click',async()=>{
    const list=Object.values(participants||{});const ready=list.filter(x=>x.ready).length;
    if(!list.length){report('입장한 교육생이 없습니다.','teacher');return;}
    if(ready!==list.length&&!confirm(`준비완료 ${ready}/${list.length}명입니다. 그래도 시작하시겠습니까?`))return;
    if(!confirm('퀴즈를 시작하면 15초마다 다음 문항으로 자동 전환됩니다. 시작할까요?'))return;
    try{await update(ref(db,`sessions/${code}/public`),{phase:'running',startAt:serverTimestamp()});}
    catch(err){report(userFacingError(err),'teacher');}
  });
  $('finishBtn').addEventListener('click',async()=>{
    if(!confirm('진행 중인 퀴즈를 조기 종료하시겠습니까?'))return;
    try{await update(ref(db,`sessions/${code}/public`),{phase:'finished'});}catch(err){report(userFacingError(err),'teacher');}
  });
  $('revealBtn').addEventListener('click',async()=>{
    if(!pub)return;
    const pos=position(pub);
    if(pub.phase==='running'&&!pos.ended){report('문항 진행이 끝난 뒤에 공개할 수 있습니다.','teacher');return;}
    if(!confirm('전체 정답 및 우수 교육생 2명을 공개할까요?'))return;
    try{
      const rankings=calculateStandings();
      const review=Array.from({length:pub.questionCount},(_,i)=>({
        question:questions[i]?.question||'',options:questions[i]?.options||[],answer:Number(answerKeys[i]?.answer||0),explanation:answerKeys[i]?.explanation||''
      }));
      const personalResults={};rankings.forEach((x,i)=>personalResults[x.uid]={correct:x.correct,firstTryCorrect:x.firstTryCorrect,total:pub.questionCount,responseMs:x.responseMs,rank:i+1});
      await update(ref(db,`sessions/${code}`),{
        results:{winners:rankings.slice(0,2).map(x=>({name:x.name,correct:x.correct,firstTryCorrect:x.firstTryCorrect,responseMs:x.responseMs})),review,finishedAt:serverTimestamp()},
        personalResults,'public/phase':'revealed'
      });
    }catch(err){report(userFacingError(err),'teacher');}
  });
  $('exportBtn').addEventListener('click',()=>{
    if(!code||!pub)return;
    const ranked=calculateStandings();
    const rows=[['순위','교육생','정답개수','첫선택정답개수','전체문항','최종정답응답시간합계(초)',...Array.from({length:pub.questionCount},(_,i)=>`Q${i+1} 최종응답/최초응답/변경수`)]];
    for(const r of ranked){const ans=Array.from({length:pub.questionCount},(_,i)=>{
      const item=responses[r.uid]?.[i];return !item?'미응답': `${CHOICE_LABELS[item.choice]}(${Number(item.choice)===Number(answerKeys[i]?.answer)?'정답':'오답'}) / 최초 ${CHOICE_LABELS[item.firstChoice??item.choice]} / 변경 ${item.changeCount||0}회`;
    });rows.push([r.rank,r.name,r.correct,r.firstTryCorrect,pub.questionCount,(r.responseMs/1000).toFixed(2),...ans]);}
    downloadCSV(rows,`공기조화설비_퀴즈성적_${code}.csv`);
  });
  $('deleteRoomBtn').addEventListener('click',async()=>{
    if(!code)return;
    const typed=prompt(`수업 ${code}의 응답 및 순위를 영구 삭제합니다. 삭제할 수업코드를 입력하세요.`);
    if(typed!==code)return;
    try{await remove(ref(db,`sessions/${code}`));unbind();show('teacherRoom',false);show('teacherProgress',false);show('teacherResult',false);report('수업 기록을 삭제했습니다.','teacher');}
    catch(err){report(userFacingError(err),'teacher');}
  });
  function unbind(){for(const u of unsubs)u();unsubs=[];if(tick){clearInterval(tick);tick=null;}code='';pub=null;questions={};answerKeys={};participants={};presence={};responses={};revealed=false;}
  function bindRoom(c){
    unbind();code=c;show('teacherRoom',true);txt('teacherCode',c);
    const url=quizLink(c),a=$('studentLink');a.href=url;a.textContent=url;
    const projected=$('displayLink');projected.href=screenLink(c);projected.textContent='강의실 화면 열기 ↗';
    // 제3자 QR 생성 서비스에는 수업코드가 포함된 URL만 전송됩니다(학생 데이터는 전송되지 않음).
    const qr=$('qrArea');empty(qr);
    const img=document.createElement('img');img.alt='교육생용 수업 QR 코드';
    img.src='https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=10&data='+encodeURIComponent(url);
    img.onerror=()=>{empty(qr);qr.append(node('span','','QR 미표시 · 링크 공유'));};qr.append(img);
    const base=`sessions/${c}`;
    const listen=(path,cb)=>unsubs.push(onValue(ref(db,`${base}/${path}`),s=>{cb(s.val());render();},e=>report(userFacingError(e),'teacher')));
    listen('public',v=>{pub=v;});listen('questions',v=>{questions=v||{};});listen('answerKeys',v=>{answerKeys=v||{};});
    listen('participants',v=>{participants=v||{};});listen('presence',v=>{presence=v||{};});listen('responses',v=>{responses=v||{};});
    tick=setInterval(render,100);render();
  }
  function render(){
    if(!code||!pub)return;
    const part=Object.entries(participants||{}),ready=part.filter(([k,v])=>v.ready).length;
    const online=part.filter(([id])=>presence[id]).length;
    txt('readyCount',`${ready} / ${part.length}`);txt('onlineCount',`${online}명`);txt('rosterTotal',`${part.length}명 입장`);
    $('readyProgress').style.width=part.length?(100*ready/part.length)+'%':'0%';
    const roster=$('roster');empty(roster);
    if(!part.length)roster.append(node('div','empty-state','아직 입장한 교육생이 없습니다.'));
    part.sort((a,b)=>(a[1].joinedAt||0)-(b[1].joinedAt||0)).forEach(([id,p])=>{
      const row=node('div','roster-row');row.append(node('span','',p.name||'이름 없음'),node('small','',presence[id]?'● 접속':'○ 오프라인'),node('span','r-status '+(p.ready?'good':'bad'),p.ready?'준비완료':'미준비'));roster.append(row);
    });
    const ended=pub.phase==='running'&&position(pub).ended;
    const stage=pub.phase==='lobby'?'대기 중':pub.phase==='revealed'?'정답 공개':pub.phase==='finished'||ended?'응답 종료':'진행 중';
    txt('teacherPhase',stage);
    show('startBtn',pub.phase==='lobby');
    show('finishBtn',pub.phase==='running'&&!ended);
    show('revealBtn',(pub.phase==='running'&&ended)||pub.phase==='finished');
    show('exportBtn',pub.phase==='revealed'||pub.phase==='finished'||ended);
    show('teacherProgress',pub.phase!=='lobby');
    if(pub.phase!=='lobby')renderProgress();
    show('teacherResult',pub.phase==='revealed');
    if(pub.phase==='revealed')renderStandings();
  }
  function renderProgress(){
    if(!pub)return;
    const pos=position(pub),i=pub.phase==='running'?pos.index:Number(pub.questionCount)-1;
    const index=Math.max(0,i),q=questions[index]||{};
    txt('teacherProgressChip',pub.phase==='running'&&!pos.ended?`Q ${index+1}/${pub.questionCount}`:'진행 종료');
    txt('teacherQnum',`Q ${pad(index+1)} / ${pub.questionCount}`);
    setTimer('teacherClock','teacherTimerBar',pub.phase==='running'&&!pos.ended?pos.left:0,pub.durationMs||DURATION);
    txt('teacherQtitle',q.question||'문항 로딩 중');txt('teacherQbox',q.box||'');show('teacherQbox',Boolean(q.box));
    txt('teacherAnswer',Number.isInteger(answerKeys[index]?.answer)?CHOICE_LABELS[answerKeys[index].answer]:'—');
    let count=0;Object.values(responses).forEach(rs=>{if(rs?.[index])count++;});
    txt('submittedCount',`${count} / ${Object.keys(participants).length}`);
    const opts=$('teacherQoptions');empty(opts);
    (q.options||[]).forEach((x,j)=>opts.append(node('div','mini-option'+(Number(answerKeys[index]?.answer)===j?' correct':''),`${CHOICE_LABELS[j]} ${x}`)));
  }
  function calculateStandings(){
    if(!pub)return [];
    const duration=pub.durationMs||DURATION,start=Number(pub.startAt||0),N=Number(pub.questionCount||0);
    return Object.entries(participants||{}).map(([uid,p])=>{
      let correct=0,firstTryCorrect=0,rt=0,lastCorrect=Infinity;
      for(let i=0;i<N;i++){
        const a=responses?.[uid]?.[i];if(!a)continue;
        const stamp=Number(a.submittedAt||0),qStart=start+i*duration;
        // 마지막 선택이 15초 안에 도착한 경우에만 점수 인정.
        if(stamp<qStart||stamp>=qStart+duration)continue;
        if(Number(a.choice)===Number(answerKeys?.[i]?.answer)){
          correct++;
          if(Number(a.firstChoice??a.choice)===Number(answerKeys?.[i]?.answer))firstTryCorrect++;
          rt+=Math.max(0,stamp-qStart);lastCorrect=Math.min(lastCorrect,stamp);
        }
      }
      return {uid,name:p.name||'미등록',correct,firstTryCorrect,responseMs:rt,lastCorrect};
    }).sort((a,b)=>b.correct-a.correct||b.firstTryCorrect-a.firstTryCorrect||a.responseMs-b.responseMs||a.lastCorrect-b.lastCorrect||a.name.localeCompare(b.name,'ko')).map((x,i)=>({...x,rank:i+1}));
  }
  function renderStandings(){
    const ranked=calculateStandings();drawWinners('teacherWinners',ranked.slice(0,2));
    const target=$('teacherLeaderboard');empty(target);
    ranked.forEach(r=>{
      const item=node('div','leader-row');item.append(node('span','pos',`${r.rank}위`),node('strong','',r.name),node('span','',`${r.correct}/${pub.questionCount}개`),node('span','',`첫정답 ${r.firstTryCorrect} · ${(r.responseMs/1000).toFixed(2)}초`));target.append(item);
    });
  }
}
