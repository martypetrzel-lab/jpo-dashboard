import test from "node:test";
import assert from "node:assert/strict";
import PDFDocument from "pdfkit";
import { buildAnalyticalReport, drawProfessionalReportPdf } from "../server.js";

function sampleRows(count) {
  return Array.from({length:count},(_,i)=>({
    id:`sample-${i}`,source:["stredocesky","praha","pardubicky"][i%3],region:["Středočeský kraj","Hlavní město Praha","Pardubický kraj"][i%3],
    title:i===0?"Velmi dlouhý český název události ěščřžýáíéůúďťň ".repeat(8):`Technická pomoc ${i}`,
    pub_date:`2026-09-21T${String(i%24).padStart(2,"0")}:00:00Z`,city_text:`Lokalita ${i%12}`,district_text:`Okres ${i%5}`,
    event_type:["fire","traffic","tech","utility_water"][i%4],is_jpo_event:i%4!==3,is_closed:i%3!==0,status_source:i%7===0?"unknown":i%3!==0?"explicit_closed":"explicit_open",
    start_time_iso:i%3!==0?"2026-09-21T08:00:00Z":null,end_time_iso:i%3!==0?"2026-09-21T09:24:00Z":null,duration_min:i%3!==0?84:null,duration_source:i%3!==0?"rss_start_and_end":null,duration_is_estimate:false,
    lat:i%4?50.1:null,lon:i%4?14.5:null,geo_precision:i%4?"manual":null,geo_verified:i%4!==0,first_seen_at:"2026-09-21T08:00:00Z",created_at:"2026-09-21T08:00:00Z"
  }));
}

async function render(count,type="day",key="2026-09-21") {
  const built=buildAnalyticalReport(type,key,sampleRows(count));
  const row={id:42,...built,created_at:"2026-09-22T08:00:00Z",updated_at:"2026-09-22T08:00:00Z"};
  const doc=new PDFDocument({size:"A4",layout:"portrait",margin:40,bufferPages:true,compress:false});
  const chunks=[];doc.on("data",chunk=>chunks.push(chunk));
  const done=new Promise((resolve,reject)=>{doc.on("end",()=>resolve(Buffer.concat(chunks)));doc.on("error",reject);});
  drawProfessionalReportPdf(doc,row);doc.end();return done;
}

function pageCount(buffer){return (buffer.toString("latin1").match(/\/Type \/Page\b/g)||[]).length;}

test("professional PDF has one real page for an empty report without footer-created pages",async()=>{
  const pdf=await render(0);assert.equal(pdf.subarray(0,4).toString(),"%PDF");assert.equal(pageCount(pdf),1);
});

test("long Czech report paginates tables without runaway blank pages",async()=>{
  const pdf=await render(80,"month","2026-09");const pages=pageCount(pdf);assert.ok(pages>=2);assert.ok(pages<=8,`unexpected ${pages} pages`);assert.ok(pdf.length>20000);
});

test("daily, weekly and monthly report variants render",async()=>{
  for(const [type,key] of [["day","2026-09-21"],["week","2026-W39"],["month","2026-09"]]) assert.ok(pageCount(await render(1,type,key))>=1);
});
