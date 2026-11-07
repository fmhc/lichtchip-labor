"""Optional regression scenarios, executed only by remote run_page.py (?checks=...)."""


def prepare(page, scenario):
    if scenario == 'nogpu':
        page.add_init_script("Object.defineProperty(navigator, 'gpu', {value: undefined});")
    elif scenario in ('lost', 'validation', 'lifecycle'):
        page.add_init_script("""(() => {
          const original = GPUAdapter.prototype.requestDevice;
          GPUAdapter.prototype.requestDevice = async function(...args) {
            const device = await original.apply(this, args); window.testDevice = device;
            const create = device.createBuffer.bind(device);
            device.createBuffer = (...args) => {
              if (window.failAllocation) { window.failAllocation = false; throw Error('<b>injected allocation failure</b>'); }
              return create(...args);
            };
            return device;
          };
        })();""")


def run(page, scenario):
    if scenario == 'nogpu':
        page.wait_for_function("document.title === 'ERR webgpu'")
        assert page.locator('#reload').is_visible()
        assert page.locator('#run').is_disabled() and page.locator('#reset').is_disabled()
        assert page.locator('#errorText').inner_text().startswith('WebGPU unavailable')
        return 'PASS no WebGPU: explanation, disabled actions, reload'
    if scenario in ('lost', 'validation'):
        page.wait_for_function("document.querySelector('#params input') && document.querySelector('#info').textContent.includes('Grid')")
        page.locator('#specStart').click()
        if scenario == 'lost':
            page.evaluate('window.testDevice.destroy()')
        else:
            page.evaluate('window.testDevice.createBuffer({size:16, usage:0})')
        page.wait_for_function("document.title === 'ERR webgpu'")
        assert page.locator('#run').is_disabled() and page.locator('#specStart').is_disabled()
        assert page.locator('#reload').is_visible()
        status = page.locator('#status').inner_text()
        page.wait_for_timeout(500)
        assert page.locator('#status').inner_text() == status
        return f'PASS {scenario}: stopped, measurement cancelled, status stable, reload'
    if scenario != 'lifecycle':
        raise ValueError('Unknown checks scenario')
    page.wait_for_function("document.querySelector('#params input') && document.querySelector('#info').textContent.includes('Grid')")
    page.locator('#specStart').click()
    page.wait_for_function("Number(document.querySelector('#specProgress').value) > 1")
    page.locator('#reset').click()
    page.wait_for_timeout(500)
    assert page.locator('#specStart').is_enabled()
    assert page.locator('#specBadge').inner_text() == 'Ready'
    print('CHECK: reset during recording recovered')
    page.locator('#specStart').click()
    page.locator('#preset').select_option('coupler')
    page.wait_for_function("document.querySelector('#info').textContent.includes('Coupling length')")
    page.wait_for_timeout(300)
    assert page.locator('#specState').inner_text() == ''
    print('CHECK: preset change discarded old spectrum/readbacks')
    page.locator('#preset').select_option('ring')
    page.wait_for_function("document.querySelector('#info').textContent.includes('Circumference')")
    # A thrown allocator leaves all old GPU buffers, scene and accepted parameters intact.
    page.locator('details.setup').evaluate('(el) => el.open = true')
    radius = page.locator('input[type=number][aria-describedby=help-R]')
    old = radius.input_value()
    page.evaluate('window.failAllocation = true')
    radius.fill('131'); radius.press('Tab')
    page.wait_for_function("document.title === 'ERR input'")
    assert radius.input_value() == old, f'Radius after failure: {radius.input_value()} expected {old}'
    assert page.locator('#errorText').inner_text() == '<b>injected allocation failure</b>', 'Error text differs'
    assert page.locator('#errorText b').count() == 0, 'Error interpreted as HTML'
    assert page.locator('#info').text_content().startswith('Circumference'), f'Previous scene info missing: {page.locator("#info").text_content()}'
    print('CHECK: failed allocation preserved scene and parameters; error is text')
    radius.fill('132'); radius.press('Tab')
    page.wait_for_function("document.title === 'Lichtchip Lab'")
    page.locator('#specStart').click()
    page.wait_for_function("document.querySelector('#specBadge').textContent.startsWith('DFT')", polling=10, timeout=120000)
    page.locator('#reset').click()
    page.wait_for_timeout(1000)
    assert page.locator('#specBadge').inner_text() == 'Ready'
    assert page.locator('#specState').inner_text() == ''
    assert page.locator('#specStart').is_enabled()
    print('CHECK: reset cancelled DFT without stale result')
    # Invalid UI values: shared validator must restore the accepted value.
    amp = page.locator('input[type=number][aria-describedby=help-ampA]')
    old = amp.input_value(); amp.fill('99'); amp.press('Tab')
    page.wait_for_function("document.title === 'ERR input'")
    assert amp.input_value() == old
    page.locator('#swMin').fill('1'); page.locator('#swMax').fill('0.5')
    page.locator('#swStart').click()
    assert 'min < A max' in page.locator('#errorText').inner_text()
    print('CHECK: invalid UI amplitude and reversed ramp rejected')
    result = page.evaluate("""async () => {
      const {spectrumDFT, resonance} = await import('./js/spectrum.js');
      const {gridBudget} = await import('./js/validation.js');
      for (const [w,h,lim] of [[300000,2,{}], [2000,2000,{}], [100,100,{maxBufferSize:100}]]) {
        let rejected = false; try { gridBudget(w,h,lim); } catch { rejected=true; }
        if (!rejected) throw Error('grid limit accepted');
      }
      const n=64, nts=3, w0=.2, bw=.04, dt=.5;
      const ts=Float32Array.from({length:n*nts},(_,i)=>Math.sin(i*.23));
      const got=await spectrumDFT(ts,n,nts,w0,bw,dt,()=>true,()=>{});
      let maximum=0;
      for(let i=0;i<700;i++) {
        const wl=2*Math.PI/(w0*(1+bw*1.2*(1-2*i/699)));
        const cr=Math.cos(2*Math.PI/wl*dt), si=Math.sin(2*Math.PI/wl*dt);
        const re=new Float64Array(nts),im=new Float64Array(nts);let c=1,s=0;
        for(let k=0;k<n;k++) {
          for(let j=0;j<nts;j++){const v=ts[k*nts+j];re[j]+=v*c;im[j]-=v*s;}
          const c2=c*cr-s*si;s=s*cr+c*si;c=c2;
        }
        for(let j=0;j<nts;j++)maximum=Math.max(maximum,Math.abs(got.power[j][i]-(re[j]*re[j]+im[j]*im[j])));
      }
      if(maximum!==0)throw Error('DFT differs');
      let active=true, blocks=0;
      const cancelled=await spectrumDFT(ts,n,nts,w0,bw,dt,()=>active,()=>{if(++blocks===2)active=false;});
      if(cancelled!==null)throw Error('DFT cancellation failed');
      const wl=Array.from({length:401},(_,i)=>30+i*.01);
      const T=[Float64Array.from(wl,x=>.9-.7/(1+((x-32)/.1)**2))];
      const spec={wl,T,duration:100000,tailRatio:0}; const r=resonance(spec,0,32);
      if(!r||Math.abs(r.width/.2-1)>.01)throw Error('linewidth estimate failed');
      if(resonance({...spec,duration:1000},0,32))throw Error('unresolved linewidth accepted');
      if(resonance({...spec,tailRatio:.1},0,32))throw Error('ringdown accepted');
      if(resonance({...spec,wl:wl.slice(0,202),T:[T[0].slice(0,202)]},0,32))throw Error('clipped line accepted');
      return {DFTMaximumDifference:maximum,cancellation:true,gridLimits:true,lineWidth:r.width};
    }""")
    print('CHECK:', result)
    page.locator('#run').click()
    page.evaluate("document.title = 'PASS checks'")
    return 'PASS lifecycle, validation, DFT equivalence/cancellation and linewidth guards'
