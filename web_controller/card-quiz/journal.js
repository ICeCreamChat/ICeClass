(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory(require('./model.js'));else root.CardQuizJournal=factory(root.CardQuizModel);})(globalThis,function(Model){
  'use strict';
  const clone=value=>JSON.parse(JSON.stringify(value));
  function canonical(value){
    if(value===null||typeof value!=='object')return JSON.stringify(value);
    if(Array.isArray(value))return'['+value.map(canonical).join(',')+']';
    return'{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  }
  function create(session){return{session:clone(session),events:[],receipts:{},syncedSeq:0,reviewError:null};}
  class Controller{
    constructor(journal,persist){this.journal=clone(journal);this.persist=persist;this.queue=Promise.resolve();this.pending=null;}
    get session(){return this.journal.session;}
    dispatch(command){
      const captured=clone(command),operation=this.queue.then(()=>this.process(captured));
      this.queue=operation.catch(()=>{});return operation;
    }
    async process(command){
      const fingerprint=canonical(command),previous=this.journal.receipts[command.id];
      if(previous){
        let stored;try{stored=canonical(JSON.parse(previous.fingerprint));}catch{}
        if(stored!==fingerprint)throw new Error('请求编号已用于不同内容，请重新操作。');return clone(previous.result);
      }
      if(this.pending){
        if(this.pending.id!==command.id)throw new Error('保存尚未确认，请先重试原请求或重新打开核对本机记录。');
        if(this.pending.fingerprint!==fingerprint)throw new Error('请求编号已用于不同内容，请重新操作。');
      }else{
        if(new TextEncoder().encode(canonical(command.payload||{})).byteLength>64*1024)
          throw new Error('题干、选项和知识点的合计内容超过 64 KiB，请缩短后再保存。');
        const at=Date.now(),session=Model.apply(this.session,command,at),journal=clone(this.journal);
        journal.session=session;
        journal.events.push({seq:session.seq,id:command.id,action:command.action,at,payload:clone(command.payload||{}),questionId:command.questionId||null,roundId:command.roundId||null,generation:command.generation,sourceId:command.sourceId});
        const result={seq:session.seq,state:Model.publicState(session),status:'confirmed'};
        journal.receipts[command.id]={fingerprint,result};
        // A rejected bridge reply can follow a successful durable write. Never recompute this proposal.
        this.pending={id:command.id,fingerprint,journal,result};
      }
      const pending=this.pending,persisted=await this.persist(clone(pending.journal));
      if(!persisted||typeof persisted!=='object'||Array.isArray(persisted))throw new Error('保存回执缺失，请重新打开核对本机记录。');
      const saved=clone(persisted);
      const receipt=saved.receipts?.[command.id];
      if(receipt?.fingerprint!==fingerprint||canonical(receipt.result)!==canonical(pending.result)||
          saved.session?.id!==pending.journal.session.id||saved.session?.seq!==pending.result.seq)
        throw new Error('保存回执与请求不匹配，请重新打开核对本机记录。');
      this.journal=saved;this.pending=null;return clone(receipt.result);
    }
  }
  return{create,Controller,canonical};
});
