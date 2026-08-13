const{execSync,spawn}=require('child_process');
execSync('npm run build',{stdio:'inherit'});
const{chromium}=require('playwright');
const cp=spawn('node',['dist/server.js'],{env:Object.assign({},process.env,{PORT:'5313'})});
cp.stdout.on('data',d=>process.stdout.write('SERVER: '+d));
cp.stderr.on('data',d=>process.stderr.write('SERVER: '+d));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  let fail=null,R=null;
  try{
    const t0=Date.now();let up=false;
    while(Date.now()-t0<3000){try{const r=await fetch('http://127.0.0.1:5313/');if(r.ok){up=true;break}}catch(e){}await sleep(150)}
    if(!up)throw new Error('server_not_ready');
    const br=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required']});
    const p=await br.newPage();
    p.on('pageerror',e=>console.log('PAGEERROR: '+e.message));
    await p.goto('http://127.0.0.1:5313/');
    await p.setInputFiles('#file','fixtures/wide.mp4');
    await p.waitForFunction(()=>window.__loom&&window.__loom.hasVideo===true,null,{timeout:20000});
    const box=await p.locator('#stage').boundingBox();
    const cy=box.y+box.height/2;
    await p.mouse.move(box.x+box.width-2,cy);await sleep(1200);
    const right=await p.evaluate(()=>({x:window.__loom.frame.x,w:window.__loom.frame.width,vw:window.__loom.videoWidth}));
    await p.mouse.move(box.x+2,cy);await sleep(1200);
    const left=await p.evaluate(()=>window.__loom.frame.x);
    await p.mouse.move(box.x+box.width*0.5,cy);await sleep(1200);
    const mid=await p.evaluate(()=>window.__loom.frame.x);
    await p.evaluate(()=>{window.__loom.setTime(1);window.__loom.play()});
    for(let i=0;i<14;i++){await p.mouse.move(box.x+box.width*0.75+(i%2),cy);await sleep(100)}
    await p.evaluate(()=>window.__loom.pause());
    const rec=await p.evaluate(()=>({s15:window.__loom.sampleTrack(1.5),s50:window.__loom.sampleTrack(5.0),t:window.__loom.currentTime}));
    await p.evaluate(()=>window.__loom.setTime(1.5));await sleep(700);
    const rep=await p.evaluate(()=>({fx:window.__loom.frame.x,pr:window.__loom.previewSrcRect.x}));
    R={right:right,left:left,mid:mid,rec:rec,rep:rep};
    await br.close();
  }catch(e){fail=e&&e.message}
  cp.kill('SIGKILL');
  if(fail){console.error('FAIL: error='+fail);process.exit(1)}
  const maxX=R.right.vw-R.right.w;
  const expMid=R.right.vw/2-R.right.w/2;
  const expRec=R.right.vw*0.75-R.right.w/2;
  const okClampR=R.right.x<=maxX+0.6&&R.right.x>maxX-14;
  const okClampL=R.left>=-0.6&&R.left<14;
  const okMid=Math.abs(R.mid-expMid)<70;
  const okRec=R.rec.s15.source==='manual'&&Math.abs(R.rec.s15.x-expRec)<110;
  const okOther=R.rec.s50.source!=='manual';
  const okReplay=Math.abs(R.rep.fx-R.rec.s15.x)<15&&Math.abs(R.rep.pr-R.rep.fx)<2;
  if(!(okClampR&&okClampL&&okMid&&okRec&&okOther&&okReplay)){
    console.error('FAIL: frame.x_at_right_edge='+R.right.x+' expected in ('+(maxX-14)+','+(maxX+0.6)+'); frame.x_at_left_edge='+R.left+' expected ~0; frame.x_at_center='+R.mid+' expected~'+expMid.toFixed(1)+'; recorded_at_1.5='+JSON.stringify(R.rec.s15)+' expected source=manual x~'+expRec.toFixed(1)+'; sample_at_5.0='+JSON.stringify(R.rec.s50)+' expected source!=manual; replay_frame.x='+R.rep.fx+' expected ~recorded '+R.rec.s15.x+'; previewSrcRect.x='+R.rep.pr+' expected ==frame.x; played_until='+R.rec.t);
    process.exit(1);
  }
  console.log('MOUSE_OK');
})();
