import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withPublicCache} from '../server/public-cache.mjs';
const origin='https://club.example',url=origin+'/api/club/events';
function fixture(){const values=new Map();return {values,async match(k){return values.get(k.url)?.clone();},async put(k,r){values.set(k.url,r.clone());},async delete(k){return values.delete(k.url);}};}
const response=items=>new Response(JSON.stringify(items),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
test('los socios y administradores no reciben el calendario público anterior al guardado',async()=>{
 const cache=fixture();await withPublicCache(new Request(url),cache,async()=>response([]));let reads=0;
 for(const cookie of ['club_member_session=member-test','other=1; club_member_session=member-test; extra=2','club_session=admin-test']){
  const r=await withPublicCache(new Request(url,{headers:{cookie}}),cache,async()=>{reads++;return response([{id:'nuevo',date:'2099-07-16'}]);});
  assert.equal((await r.json())[0].id,'nuevo');assert.equal(r.headers.get('Cache-Control'),'no-store');
 }
 assert.equal(reads,3);
});
test('el calendario anónimo conserva su caché breve sin multiplicar lecturas D1',async()=>{
 const cache=fixture();let reads=0;const next=async()=>{reads++;return response([{id:'existente'}]);};
 await withPublicCache(new Request(url),cache,next);const r=await withPublicCache(new Request(url),cache,next);
 assert.equal(reads,1);assert.equal((await r.json())[0].id,'existente');assert.equal(r.headers.get('Cache-Control'),'no-store');
});
test('guardar, editar y borrar un evento invalida la copia pública solo si tiene éxito',async()=>{
 for(const [method,path]of [['POST',''],['POST','/event-one'],['DELETE','/event-one']]){
  const cache=fixture();await withPublicCache(new Request(url),cache,async()=>response([]));
  await withPublicCache(new Request(url+path,{method}),cache,async()=>new Response('{}',{status:403}));assert.equal(cache.values.has(url),true);
  await withPublicCache(new Request(url+path,{method}),cache,async()=>response({ok:true}));assert.equal(cache.values.has(url),false);
  const fresh=await withPublicCache(new Request(url),cache,async()=>response([{id:'actualizado'}]));assert.equal((await fresh.json())[0].id,'actualizado');
 }
});
test('los accesos personales y las inscripciones no se almacenan en caché pública',async()=>{
 const cache=fixture();for(const path of ['/api/club/events/access','/api/club/member-access/session','/api/club/events/one/signups']){
  let reads=0;for(let i=0;i<2;i++)await withPublicCache(new Request(origin+path),cache,async()=>{reads++;return response({member:{id:'test'}});});assert.equal(reads,2);
 }
 assert.equal(cache.values.size,0);
});

test('la copia anterior de eventos solo se usa para errores temporales y visitantes', async () => {
 const cache = fixture();
 await withPublicCache(new Request(url), cache, async () => response([{id:'guardado'}]));
 const key = new Request(url);
 for (const seconds of [70, 310]) {
  const cached = await cache.match(key);
  const headers = new Headers(cached.headers);
  headers.set('X-Club-Cache-Captured-At', String(Date.now() - seconds * 1000));
  await cache.put(key, new Response(cached.body, {headers}));
  const unavailable = () => new Response('{}', {status:503});
  assert.equal((await withPublicCache(new Request(url, {headers:{cookie:'club_member_session=test'}}), cache, unavailable)).status, 503);
  assert.equal((await withPublicCache(new Request(url), cache, () => new Response('{}', {status:403}))).status, 403);
  const result = await withPublicCache(new Request(url), cache, unavailable);
  assert.equal(result.status, seconds < 300 ? 200 : 503);
  assert.equal(result.headers.get('X-Club-Data-Stale'), seconds < 300 ? '1' : null);
 }
});

test('solo cambios aceptados en anuncios invalidan la lista del mercadillo', async () => {
 for (const path of ['/api/admin/listings/one','/api/admin/listings/one/edit']) {
  const cache = fixture(), market = origin + '/api/market/listings';
  await withPublicCache(new Request(market), cache, async () => response([{id:'anterior'}]));
  const request = () => new Request(origin+path,{method:'POST'});
  await withPublicCache(request(), cache, async () => new Response('{}',{status:403}));
  assert.equal(cache.values.has(market), true);
  await withPublicCache(request(), cache, async () => response({ok:true}));
  assert.equal(cache.values.has(market), false);
  const fresh = await withPublicCache(new Request(market),cache,async()=>response([{id:'nuevo'}]));
  assert.equal((await fresh.json())[0].id, 'nuevo');
 }
});

const photo=()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg','Content-Length':'3','Cache-Control':'no-store'}});
test('las fotos guardadas en D1 se sirven desde la caché para visitantes anónimos',async()=>{
 const cache=fixture(),src=origin+'/api/gallery/photos/foto-1';let reads=0;const next=async()=>{reads++;return photo();};
 const first=await withPublicCache(new Request(src),cache,next),second=await withPublicCache(new Request(src),cache,next);
 assert.equal(reads,1);assert.equal(first.headers.get('Cache-Control'),'public, max-age=86400');assert.equal(second.headers.get('Cache-Control'),'public, max-age=86400');
 assert.deepEqual([...new Uint8Array(await second.arrayBuffer())],[1,2,3]);assert.equal(second.headers.get('X-Club-Cache-Captured-At'),null);
});
test('las fotos del garaje caducan pronto para respetar moderación y cambios de perfil',async()=>{
 for(const path of ['/api/garage/photos/uno','/api/garage/profiles/socio/photo']){const r=await withPublicCache(new Request(origin+path),fixture(),async()=>photo());assert.equal(r.headers.get('Cache-Control'),'public, max-age=600');}
});
test('administradores, mediciones y otras rutas no comparten copias de fotos',async()=>{
 const cache=fixture();let reads=0;const next=async()=>{reads++;return photo();};
 for(let i=0;i<2;i++){const r=await withPublicCache(new Request(origin+'/api/market/photos/p1',{headers:{cookie:'club_session=admin'}}),cache,next);assert.equal(r.headers.get('Cache-Control'),'no-store');}
 for(let i=0;i<2;i++)await withPublicCache(new Request(origin+'/api/garage/photos/uno?medir=1'),cache,next);
 assert.equal(reads,4);assert.equal(cache.values.size,0);
 const missing=await withPublicCache(new Request(origin+'/api/market/photos/oculta'),cache,async()=>new Response('{}',{status:404,headers:{'Cache-Control':'no-store'}}));
 assert.equal(missing.headers.get('Cache-Control'),'no-store');assert.equal(cache.values.size,0);
});
test('los vídeos por rangos los guarda el navegador pero no la caché compartida',async()=>{
 const cache=fixture();const r=await withPublicCache(new Request(origin+'/api/cms/media/v1',{headers:{range:'bytes=0-1'}}),cache,async()=>new Response(new Uint8Array([1,2]),{status:206,headers:{'Content-Range':'bytes 0-1/9','Cache-Control':'no-store'}}));
 assert.equal(r.status,206);assert.equal(r.headers.get('Cache-Control'),'public, max-age=86400');assert.equal(cache.values.size,0);
});
test('borrar una foto de la galería retira su copia compartida',async()=>{
 const cache=fixture(),src=origin+'/api/gallery/photos/foto-2';await withPublicCache(new Request(src),cache,async()=>photo());assert.equal(cache.values.has(src),true);
 await withPublicCache(new Request(src,{method:'DELETE'}),cache,async()=>new Response('{}',{status:403}));assert.equal(cache.values.has(src),true);
 await withPublicCache(new Request(src,{method:'DELETE'}),cache,async()=>new Response('{"ok":true}'));assert.equal(cache.values.has(src),false);
});
