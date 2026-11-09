import {initializeApp} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import {getAuth,signInAnonymously} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import {getDatabase,ref,get,onValue} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import {firebaseConfig} from './firebase-config.js';
const $=id=>document.getElementById(id), stages=['intro','waiting','question','ended','revealed'],marks=['①','②','③','④'];
let db,auth,offsetMs=0,code='',room=null,loaded=-1,requested=-1,inFlight=false,currentQuestion=null,unsubs=[],ticker=null,resultsLoaded=false,resultLoading=false,lastAttemptAt=0;
function stage(which){for(const id of stages)$(id).classList.toggle('hidden',id!==which);}
function error(msg){$('displayError').textContent=String(msg);$('displayError').classList.remove('hidden');}
function clearError(){$('displayError').classList.add('hidden');}
function serverNow(){return Date.now()+offsetMs;}
function pos(){if(!room||room.phase!=='running'||!room.startAt)return {index:-1,left:0,ended:false};
 const dur=Number(room.durationMs)||15000,n=Number(room.questionCount)||10,elapsed=Math.max(0,serverNow()-Number(room.startAt)),i=Math.floor(elapsed/dur);
 return {index:Math.min(n-1,i),left:Math.max(0,dur-(elapsed%dur)),ended:i>=n};}
function text(id,value){$(id).textContent=String(value??'');}
function resetQuestion(){loaded=-1;requested=-1;currentQuestion=null;text('bigTitle','문제를 불러오는 중…');$('bigOptions').replaceChildren();$('bigSource').classList.add('hidden');}
function renderQuestion(q){if(!q)return;currentQuestion=q;text('bigTitle',q.question);text('bigSource',q.box||'');$('bigSource').classList.toggle('hidden',!q.box);
 const target=$('bigOptions');target.replaceChildren();(q.options||[]).forEach((label,i)=>{const el=document.createElement('div');el.className='display-option';const b=document.createElement('span');b.className='display-number';b.textContent=marks[i];const a=document.createElement('span');a.textContent=label;el.append(b,a);target.append(el);});}
async function loadQuestion(i){if(inFlight||requested===i||Date.now()-lastAttemptAt<450)return;
 inFlight=true;requested=i;lastAttemptAt=Date.now();const targetCode=code;
 try{const s=await get(ref(db,`sessions/${code}/questions/${i}`));if(targetCode!==code||pos().index!==i)return;
 if(!s.exists())throw new Error('문제가 아직 열리지 않았습니다.');loaded=i;renderQuestion(s.val());clearError();}
 catch(e){requested=-1;if(targetCode===code&&pos().index===i)text('bigTitle','문항을 동기화하는 중…');}
 finally{inFlight=false;}}
async function showResults(){if(resultsLoaded||resultLoading||!room)return;resultLoading=true;
 try{const snap=await get(ref(db,`sessions/${code}/results`));if(!snap.exists())return;
 const wins=snap.val().winners||[],target=$('bigWinners');target.replaceChildren();
 wins.forEach((w,i)=>{const el=document.createElement('div');el.className='display-winner';const rank=document.createElement('span');rank.textContent=i===0?'🥇 1위':'🥈 2위';const name=document.createElement('strong');name.textContent=w.name||'미등록';const score=document.createElement('span');score.textContent=`정답 ${w.correct}개 · 첫 선택 정답 ${w.firstTryCorrect||0}개 · 합계 ${(Number(w.responseMs||0)/1000).toFixed(2)}초`;el.append(rank,name,score);target.append(el);});
 resultsLoaded=true;
 }catch(e){error('결과를 읽지 못했습니다. 잠시 후 다시 확인해 주세요.');}finally{resultLoading=false;}}
function tick(){if(!room)return;
 if(room.phase==='lobby'){stage('waiting');text('waitingCode',code);return;}
 if(room.phase==='revealed'){stage('revealed');showResults();return;}
 if(room.phase==='finished'){stage('ended');return;}
 const p=pos();if(p.ended){stage('ended');return;}
 stage('question');text('questionNo',`Q ${String(p.index+1).padStart(2,'0')} / ${room.questionCount}`);
 text('bigClock',(p.left/1000).toFixed(1)+'초');$('bigClock').classList.toggle('urgent',p.left<5000);
 $('bigFill').style.width=(100*p.left/(Number(room.durationMs)||15000))+'%';
 if(loaded!==p.index){if(requested!==p.index)resetQuestion();loadQuestion(p.index);}
}
async function connect(e){e?.preventDefault();const value=$('roomCode').value.trim();if(!/^\d{6}$/.test(value)){error('6자리 수업코드를 입력하세요.');return;}
 clearError();try{
 if(!firebaseConfig.apiKey||String(firebaseConfig.apiKey).includes('PASTE_')||!firebaseConfig.databaseURL)throw new Error('firebase-config.js 설정이 필요합니다.');
 if(!db){const app=initializeApp(firebaseConfig);db=getDatabase(app);auth=getAuth(app);await auth.authStateReady();if(!auth.currentUser)await signInAnonymously(auth);
 onValue(ref(db,'.info/serverTimeOffset'),s=>{offsetMs=Number(s.val())||0;});}
 else if(!auth.currentUser)await signInAnonymously(auth);
 const snapshot=await get(ref(db,`sessions/${value}/public`));if(!snapshot.exists())throw new Error('수업코드를 찾지 못했습니다.');
 for(const u of unsubs)u();unsubs=[];code=value;room=snapshot.val();loaded=-1;requested=-1;resultsLoaded=false;
 const studentUrl=new URL('index.html',location.href);studentUrl.searchParams.set('code',code);
 $('displayQR').src='https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=10&data='+encodeURIComponent(studentUrl.href);
 unsubs.push(onValue(ref(db,`sessions/${code}/public`),s=>{room=s.val();if(!room){error('수업이 종료되거나 삭제되었습니다.');return;}tick();},err=>error('실시간 연결을 확인해 주세요: '+err.message)));
 const url=new URL(location.href);url.searchParams.set('code',code);history.replaceState(null,'',url.href);
 if(ticker)clearInterval(ticker);ticker=setInterval(tick,100);tick();
 }catch(err){error(err.message||String(err));}}
$('codeForm').addEventListener('submit',connect);
$('fullscreenBtn').addEventListener('click',()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen?.().catch(()=>{});else document.exitFullscreen?.().catch(()=>{});});
const fromUrl=new URL(location.href).searchParams.get('code')||'';
if(/^\d{6}$/.test(fromUrl)){$('roomCode').value=fromUrl;connect();}
