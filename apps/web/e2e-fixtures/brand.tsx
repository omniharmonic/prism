import { createRoot } from "react-dom/client";
import { PrismAppIcon, PrismMark } from "../../../packages/core/src/components/brand/PrismMark";
const sizes = [16, 24, 32, 48, 64, 96];
createRoot(document.getElementById("root")!).render(<main style={{fontFamily:"system-ui"}}>{[false,true].map(dark=><section key={String(dark)} aria-label={dark?"Dark brand":"Light brand"} style={{padding:24,background:dark?"#22242a":"#faf9f6",color:dark?"#faf9f6":"#25262a"}}>
<h1 style={{fontSize:16,margin:"0 0 18px"}}>Prism · {dark?"dark":"light"} · actual CSS pixel sizes</h1>
{["App icon","Mark","Monochrome"].map(kind=><div key={kind} style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:20,minHeight:128}}>{sizes.map(size=><div key={size} style={{width:105,display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>{kind==="App icon"?<PrismAppIcon size={size}/>:<PrismMark width={size} height={Math.round(size*2/3)} monochrome={kind==="Monochrome"}/>}<span style={{fontSize:11}}>{kind} {size}px</span></div>)}</div>)}
</section>)}</main>);
