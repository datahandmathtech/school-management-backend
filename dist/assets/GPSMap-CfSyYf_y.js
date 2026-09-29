import{r,j as e}from"./vendor-BDQv0xWK.js";import{M as m,T as u,b as y,L as o,u as b}from"./leaflet-CG7_gOri.js";import{d as j,u as v,c as k}from"./index-BlEcQnlo.js";import{a6 as w,e as S}from"./icons-CuGuB8TS.js";import{P as I}from"./Popup-Bd_pzHUf.js";delete o.Icon.Default.prototype._getIconUrl;o.Icon.Default.mergeOptions({iconRetinaUrl:"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",iconUrl:"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",shadowUrl:"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png"});const M=a=>{const i=a==="Moving",s=i?"#10b981":"#ef4444";return o.divIcon({className:"custom-car-icon",html:`
            <div style="
                background-color: ${s}; 
                width: 24px; 
                height: 24px; 
                border-radius: 50%; 
                border: 3px solid white;
                box-shadow: 0 0 10px ${s};
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
            ">
                ${i?`<div style="
                    position: absolute;
                    width: 100%;
                    height: 100%;
                    border-radius: 50%;
                    border: 2px solid ${s};
                    animation: pulse 1.5s infinite;
                "></div>`:""}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
                    <path d="M5 18H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.19M15 6h2a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3.19"/>
                    <path d="M23 13v-2c0-2.6-2.4-4.5-5-5H6c-2.6.5-5 2.4-5 5v2"/>
                    <circle cx="7.5" cy="18.5" r="2.5"/>
                    <circle cx="16.5" cy="18.5" r="2.5"/>
                </svg>
            </div>
            <style>
                @keyframes pulse {
                    0% { transform: scale(1); opacity: 1; }
                    100% { transform: scale(2); opacity: 0; }
                }
            </style>
        `,iconSize:[24,24],iconAnchor:[12,12]})},z=({vehicles:a})=>{const i=b();return r.useEffect(()=>{if(a&&a.length>0){const s=o.latLngBounds(a.map(n=>[n.lat,n.lng]));i.fitBounds(s,{padding:[50,50]})}},[a,i]),null},$=()=>{const{selectedCompany:a}=j(),{theme:i}=v(),[s,n]=r.useState([]),[d,g]=r.useState(!0),[l,h]=r.useState(!1),c=async(t=!1)=>{if(a){t&&h(!0);try{const p=JSON.parse(localStorage.getItem("userInfo")),{data:f}=await k.get(`/api/admin/live-map/${a._id}`,{headers:{Authorization:`Bearer ${p.token}`}});f.success&&n(f.liveVehicles)}catch(p){console.error("Error fetching live map data:",p)}finally{g(!1),h(!1)}}};r.useEffect(()=>{c();const t=setInterval(()=>{c(!1)},3e4);return()=>clearInterval(t)},[a]);const x=[24.5854,73.7125];return e.jsxs("div",{style:{height:"100%",minHeight:"100vh",display:"flex",flexDirection:"column",background:"radial-gradient(circle at top right, #1e293b, #0f172a)"},children:[e.jsxs("div",{style:{padding:"20px 30px",borderBottom:"1px solid rgba(255,255,255,0.05)",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(15, 23, 42, 0.6)",backdropFilter:"blur(10px)",zIndex:10},children:[e.jsxs("div",{children:[e.jsxs("h1",{style:{fontSize:"24px",fontWeight:"700",color:"white",display:"flex",alignItems:"center",gap:"10px"},children:[e.jsx(w,{size:24,color:"#0ea5e9"}),"Live GPS Tracking"]}),e.jsx("p",{style:{color:"rgba(255,255,255,0.5)",fontSize:"14px",margin:"4px 0 0 0"},children:"Real-time map view of all active vehicles (Ready for WheelsEye API)"})]}),e.jsxs("button",{onClick:()=>c(!0),disabled:l||d,style:{background:"rgba(14, 165, 233, 0.1)",color:"#0ea5e9",border:"1px solid rgba(14, 165, 233, 0.2)",padding:"10px 16px",borderRadius:"12px",display:"flex",alignItems:"center",gap:"8px",cursor:"pointer",fontWeight:"600"},children:[e.jsx(S,{size:16,className:l?"spinning":""}),l?"Syncing...":"Refresh Map",e.jsx("style",{children:".spinning { animation: spin 1s linear infinite; } @keyframes spin { 100% { transform: rotate(360deg); } }"})]})]}),e.jsx("div",{style:{flex:1,position:"relative"},children:d?e.jsx("div",{style:{display:"flex",height:"100%",alignItems:"center",justifyContent:"center",color:"white"},children:"Loading Map Data..."}):e.jsxs(m,{center:s.length>0?[s[0].lat,s[0].lng]:x,zoom:12,style:{height:"100%",width:"100%",zIndex:1},children:[e.jsx(u,{url:"https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'}),s.map(t=>e.jsx(y,{position:[t.lat,t.lng],icon:M(t.status),children:e.jsx(I,{className:"custom-popup",children:e.jsxs("div",{style:{padding:"5px",minWidth:"150px"},children:[e.jsx("h3",{style:{margin:"0 0 8px 0",fontSize:"16px",fontWeight:"800",color:"#0f172a"},children:t.carNumber}),e.jsxs("p",{style:{margin:"0 0 4px 0",fontSize:"13px",color:"#64748b"},children:[e.jsx("strong",{children:"Model:"})," ",t.model]}),e.jsxs("p",{style:{margin:"0 0 4px 0",fontSize:"13px",color:"#64748b"},children:[e.jsx("strong",{children:"Status:"}),e.jsx("span",{style:{color:t.status==="Moving"?"#10b981":"#ef4444",fontWeight:"700",marginLeft:"5px"},children:t.status})]}),e.jsxs("p",{style:{margin:"0",fontSize:"13px",color:"#64748b"},children:[e.jsx("strong",{children:"Speed:"})," ",t.status==="Moving"?`${t.speed} km/h`:"0 km/h"]})]})})},t.id)),e.jsx(z,{vehicles:s})]})}),e.jsx("style",{children:`
                .leaflet-popup-content-wrapper {
                    border-radius: 12px;
                    box-shadow: 0 10px 25px rgba(0,0,0,0.2);
                }
                .leaflet-popup-tip {
                    background: white;
                }
                .leaflet-container {
                    background: #0f172a;
                    font-family: 'Outfit', sans-serif;
                }
                /* Hide Leaflet Branding for cleaner look */
                .leaflet-control-attribution {
                    display: none !important;
                }
            `})]})};export{$ as default};
