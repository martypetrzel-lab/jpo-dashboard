import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import '../public/event-utils.js';
const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const render=source.slice(source.indexOf('function renderMap(items)'),source.indexOf('function safeInvalidateMap'));
function setup(){
 const layer={markers:[],eachLayer(fn){this.markers.forEach(fn);},clearLayers(){this.markers=[];}};
 const summary={textContent:''};
 const context={markersLayer:layer,mapEventPoints:[],mapHasFitted:true,FireWatchData,document:{getElementById:()=>summary},L:{divIcon:options=>options,marker:(point,options)=>({point,options,opened:false,popup:{scrollTop:0},bindPopup(html){this.html=html;return this;},addTo(group){group.markers.push(this);return this;},isPopupOpen(){return this.opened;},getLatLng(){return {lat:point[0],lng:point[1]};},getPopup(){return {getElement:()=>({querySelector:()=>this.popup})};},openPopup(){this.opened=true;return this;}})},makeEventIcon:()=>({}),escapeHtml:value=>String(value ?? ''),statusLabelForEvent:ev=>ev.is_closed?'ukončená':'aktivní',formatDate:value=>String(value || ''),formatDuration:value=>String(value ?? '—'),liveDurationForEvent:()=>42,fitEventMap:()=>{}};
 vm.createContext(context);vm.runInContext(render,context);return {context,layer,summary};
}
const rows=[{id:'a',title:'First',city_text:'Beroun',lat:49.9638,lon:14.072,geo_reliable:true,geo_label:'Přibližná poloha – střed obce'},{id:'b',title:'Second',city_text:'Beroun',lat:49.9638,lon:14.072,geo_reliable:true,is_closed:true},{id:'unknown',lat:50.1073,lon:14.725,geo_reliable:false}];
test('actual map renderer groups legitimate points and never renders rejected district fallback',()=>{
 const {context,layer,summary}=setup();context.renderMap(rows);assert.equal(layer.markers.length,1);assert.match(layer.markers[0].html,/First/);assert.match(layer.markers[0].html,/Second/);assert.match(layer.markers[0].html,/střed obce/);assert.match(summary.textContent,/2 na mapě · 1 bez spolehlivé polohy/);
});
test('automatic map refresh preserves open group and its scroll position; filters close removed group',()=>{
 const {context,layer}=setup();context.renderMap(rows);layer.markers[0].openPopup();layer.markers[0].popup.scrollTop=123;
 context.renderMap(rows);assert.equal(layer.markers[0].opened,true);assert.equal(layer.markers[0].popup.scrollTop,123);
 context.renderMap([rows[2]]);assert.equal(layer.markers.length,0);
});
