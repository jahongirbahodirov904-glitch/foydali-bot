(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }
  const $ = id => document.getElementById(id);
  const form = $("planForm"), taskInput = $("task"), dateInput = $("date"), timeInput = $("time");
  const message = $("formMessage"), list = $("planList"), count = $("planCount");
  const today = new Date();
  const localISO = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0,10);
  dateInput.min = localISO;
  dateInput.value = localISO;
  const suggested = new Date(Date.now() + 60 * 60 * 1000);
  timeInput.value = `${String(suggested.getHours()).padStart(2,"0")}:${String(suggested.getMinutes()).padStart(2,"0")}`;
  $("todayLabel").textContent = "📅 " + today.toLocaleDateString("uz-UZ",{weekday:"long",day:"numeric",month:"long"});
  const headers = () => {
    const h = { "Content-Type":"application/json" };
    if (tg?.initData) h["x-telegram-init-data"] = tg.initData;
    else if (location.hostname === "localhost" || location.hostname === "127.0.0.1") h["x-dev-user"] = "123456";
    return h;
  };
  async function api(url, options={}) {
    const response = await fetch(url,{...options,headers:{...headers(),...(options.headers||{})}});
    const data = await response.json().catch(()=>({error:"Server javobi o‘qilmadi."}));
    if (!response.ok) throw new Error(data.error || "Xatolik yuz berdi.");
    return data;
  }
  function make(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  async function loadPlans() {
    try {
      const data = await api("/api/plans");
      render(data.plans || []);
    } catch (e) {
      list.replaceChildren(make("div","empty",e.message + " Agar mahalliy sinov bo‘lsa, localhost manzilidan oching."));
    }
  }
  function render(plans) {
    list.replaceChildren();
    count.textContent = `${plans.length} ta`;
    if (!plans.length) {
      list.append(make("div","empty","✨ Hali reja yo‘q. Birinchi rejangni qo‘sh!"));
      return;
    }
    plans.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
    for (const p of plans) {
      const card = make("article","plan-card" + (p.done ? " done" : ""));
      const checkbox = make("input","check");
      checkbox.type = "checkbox"; checkbox.checked = Boolean(p.done);
      checkbox.setAttribute("aria-label","Bajarildi deb belgilash");
      checkbox.addEventListener("change",async()=>{
        checkbox.disabled=true;
        try { await api(`/api/plans/${encodeURIComponent(p.id)}`,{method:"PATCH",body:JSON.stringify({done:checkbox.checked})}); await loadPlans(); }
        catch(e){message.textContent=e.message;checkbox.disabled=false;checkbox.checked=!checkbox.checked;}
      });
      const content = make("div","");
      content.append(make("div","plan-title",p.task));
      const dt = new Date(`${p.date}T${p.time}:00`);
      const dateLabel = dt.toLocaleDateString("uz-UZ",{day:"numeric",month:"short",year:"numeric"});
      content.append(make("div","plan-meta",`📅 ${dateLabel} · ⏰ ${p.time}`));
      content.append(make("div","status",p.done?"✅ Bajarildi":p.notified?"🔔 Eslatma yuborildi":"🕒 Kutilmoqda"));
      const del = make("button","delete","🗑");
      del.type="button";del.setAttribute("aria-label","Rejani o‘chirish");
      del.addEventListener("click",async()=>{
        if (!confirm(`“${p.task}” rejasini o‘chirasizmi?`)) return;
        del.disabled=true;
        try { await api(`/api/plans/${encodeURIComponent(p.id)}`,{method:"DELETE"}); await loadPlans(); }
        catch(e){message.textContent=e.message;del.disabled=false;}
      });
      card.append(checkbox,content,del);list.append(card);
    }
  }
  form.addEventListener("submit",async e=>{
    e.preventDefault();message.textContent="";
    const task=taskInput.value.trim(), date=dateInput.value, time=timeInput.value;
    if(!task){message.textContent="Reja nomini yozing.";return;}
    if(!date||!time){message.textContent="Sana va vaqtni tanlang.";return;}
    if(new Date(`${date}T${time}:00`).getTime()<=Date.now()){message.textContent="Kelajakdagi sana va vaqtni tanlang.";return;}
    const button=form.querySelector("button[type=submit]");button.disabled=true;button.textContent="Saqlanmoqda…";
    try{
      await api("/api/plans",{method:"POST",body:JSON.stringify({task,date,time})});
      taskInput.value="";message.textContent="✅ Reja saqlandi. Vaqti kelganda Telegramdan eslatma olasiz.";await loadPlans();
    }catch(err){message.textContent=err.message;}
    finally{button.disabled=false;button.textContent="＋ Rejani saqlash";}
  });
  loadPlans();
})();