using System.Text.Json.Nodes;
using ICeClass.Receiver;

var root=Path.Combine(Path.GetTempPath(),"iceclass-card-quiz-check-"+Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
var count=0;
void Check(bool ok,string name){if(!ok)throw new Exception(name);count++;Console.WriteLine("PASS "+name);}
void Refuses(Action action,string name){try{action();}catch(Exception error)when(error is IOException or UnauthorizedAccessException or InvalidDataException or InvalidOperationException){Check(true,name);return;}throw new Exception("没有拒绝："+name);}
JsonObject Journal(string id)=>new(){["session"]=new JsonObject{["schema"]=1,["id"]=id,["classId"]="c1",["deviceId"]="d1",["subjectId"]="math",["seq"]=0,["generation"]=1,["source"]="board",["sourceId"]="board",["currentQuestionId"]=null,["currentRoundId"]=null,["questions"]=new JsonArray(),["endedAt"]=null},["events"]=new JsonArray(),["receipts"]=new JsonObject(),["syncedSeq"]=0,["reviewError"]=null};
JsonObject Advance(JsonObject journal,string action="answer",JsonObject? payload=null){
    var next=journal.DeepClone().AsObject();var session=next["session"]!;var seq=session["seq"]!.GetValue<int>()+1;var id=Guid.NewGuid().ToString();
    var command=new JsonObject{["action"]=action,["generation"]=session["generation"]!.DeepClone(),["id"]=id,["payload"]=payload?.DeepClone()??new JsonObject(),["questionId"]=session["currentQuestionId"]?.DeepClone(),["roundId"]=session["currentRoundId"]?.DeepClone(),["sessionId"]=session["id"]!.DeepClone(),["sourceId"]=session["sourceId"]!.DeepClone()};
    session["seq"]=seq;if(action is "add_question" or "start_round" or "end_round" or "resume_round" or "recover" or "set_source" or "set_multi_option" or "end_session")session["generation"]=session["generation"]!.GetValue<int>()+1;
    var entry=new JsonObject{["seq"]=seq,["id"]=id,["action"]=action,["at"]=1000+seq,["payload"]=command["payload"]!.DeepClone(),["questionId"]=command["questionId"]?.DeepClone(),["roundId"]=command["roundId"]?.DeepClone(),["generation"]=command["generation"]!.DeepClone(),["sourceId"]=command["sourceId"]!.DeepClone()};
    next["events"]!.AsArray().Add(entry);
    next["receipts"]![id]=new JsonObject{["fingerprint"]=command.ToJsonString(),["result"]=new JsonObject{["seq"]=seq,["status"]="confirmed",["state"]=new JsonObject{["sessionId"]=session["id"]!.DeepClone(),["seq"]=seq,["generation"]=session["generation"]!.DeepClone(),["sourceId"]=session["sourceId"]!.DeepClone()}}};return next;
}
JsonObject Receipt(JsonObject journal)=>journal["receipts"]!.AsObject().First().Value!.AsObject();
void ChangeCommand(JsonObject journal,Action<JsonObject> change){var receipt=Receipt(journal);var command=JsonNode.Parse(receipt["fingerprint"]!.GetValue<string>())!.AsObject();change(command);receipt["fingerprint"]=command.ToJsonString();}
try{
    var store=new CardQuizStore(root,"c1","d1");var id=Guid.NewGuid().ToString();var initial=Journal(id);
    store.Commit(initial);var first=Advance(initial);store.Commit(first);
    Check(store.Read(id)!["session"]!["seq"]!.GetValue<int>()==1,"已确认序号在重新打开存储后保留");
    var reopened=new CardQuizStore(root,"c1","d1");Check(JsonNode.DeepEquals(reopened.Read(id),store.Read(id)),"进程重建读取相同记录和回执");
    store.Commit(first);Check(store.Read(id)!["events"]!.AsArray().Count==1,"相同记录重试幂等");
    var conflict=first.DeepClone().AsObject();conflict["session"]!["extra"]="篡改";Refuses(()=>store.Commit(conflict),"同序号不同内容拒绝");
    var gap=Advance(Advance(first));Refuses(()=>store.Commit(gap),"缺少本机前序提交拒绝");
    var fresh = Journal(Guid.NewGuid().ToString());
    Refuses(() => store.Commit(Advance(fresh)), "首次提交不能包含作答或跳过出题");
    var firstQuestion = Advance(fresh, "add_question", new JsonObject
    {
        ["type"] = "single", ["options"] = new JsonArray("", "", "", "")
    });
    var firstQuestionId = Guid.NewGuid().ToString();
    firstQuestion["session"]!["currentQuestionId"] = firstQuestionId;
    firstQuestion["session"]!["questions"] = new JsonArray(new JsonObject
    {
        ["id"] = firstQuestionId, ["type"] = "single", ["rounds"] = new JsonArray()
    });
    store.Commit(firstQuestion);
    Check(JsonNode.DeepEquals(reopened.Read(fresh["session"]!["id"]!.GetValue<string>()), firstQuestion),
        "新课堂和第一题一次落盘并可原样恢复");
    var wrong=Advance(first);wrong["session"]!["classId"]="c2";Refuses(()=>store.Commit(wrong),"改绑后的数据不串入新班");
    var oldEvent=Advance(first);oldEvent["events"]![0]!["action"]="different";Refuses(()=>store.Commit(oldEvent),"已确认事件内容不能改写");
    store.MarkSynced(id,1);var second=Advance(first);store.Commit(second);Check(store.Read(id)!["syncedSeq"]!.GetValue<int>()==1,"旧页面提交不回退后台同步进度");
    var path=Path.Combine(root,"sessions",id+".json");using(var blocked=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read))Refuses(()=>store.Commit(Advance(second)),"写入失败不返回成功");
    Check(store.Read(id)!["session"]!["seq"]!.GetValue<int>()==2,"写入失败保留最近可用记录");
    var final=Advance(second,"end_session");final["session"]!["endedAt"]=2000;store.Commit(final);
    Refuses(()=>store.Commit(Advance(final)),"结束课堂禁止再次改写采集记录");
    store.MarkReview(id,"服务端拒绝，保留待核对");Check(store.Read(id)!["reviewError"]!.GetValue<string>().Contains("待核对"),"拒收记录保留需核对状态");
    store.SaveCache("context",new JsonObject{["classId"]="c1",["students"]=new JsonArray()});Check(store.LoadCache("context")!["classId"]!.GetValue<string>()=="c1","缓存落盘可重新读取");

    var identityInitial=Journal(Guid.NewGuid().ToString());store.Commit(identityInitial);
    (string Name,Action<JsonObject> Corrupt)[] corruptions=[
        ("事件缺少请求回执",j=>j["receipts"]!.AsObject().Clear()),
        ("孤立回执与事件编号不一致",j=>{var receipts=j["receipts"]!.AsObject();var value=receipts.First().Value!.DeepClone();receipts.Clear();receipts[Guid.NewGuid().ToString()]=value;}),
        ("缺少请求指纹",j=>Receipt(j).Remove("fingerprint")),
        ("指纹不是命令 JSON",j=>Receipt(j)["fingerprint"]="input:invalid"),
        ("指纹命令不是对象",j=>Receipt(j)["fingerprint"]="[]"),
        ("指纹请求编号不一致",j=>ChangeCommand(j,c=>c["id"]=Guid.NewGuid().ToString())),
        ("指纹课堂编号不一致",j=>ChangeCommand(j,c=>c["sessionId"]=Guid.NewGuid().ToString())),
        ("指纹动作不一致",j=>ChangeCommand(j,c=>c["action"]="end_round")),
        ("指纹内容不一致",j=>ChangeCommand(j,c=>c["payload"]=new JsonObject{["option"]="D"})),
        ("指纹代次不一致",j=>ChangeCommand(j,c=>c["generation"]=999)),
        ("指纹来源不一致",j=>ChangeCommand(j,c=>c["sourceId"]="phone-old")),
        ("指纹题目不一致",j=>ChangeCommand(j,c=>c["questionId"]=Guid.NewGuid().ToString())),
        ("指纹轮次不一致",j=>ChangeCommand(j,c=>c["roundId"]=Guid.NewGuid().ToString())),
        ("回执缺少确认结果",j=>Receipt(j).Remove("result")),
        ("回执序号与事件不一致",j=>Receipt(j)["result"]!["seq"]=999),
        ("回执公开状态序号不一致",j=>Receipt(j)["result"]!["state"]!["seq"]=999),
        ("回执公开状态课堂不一致",j=>Receipt(j)["result"]!["state"]!["sessionId"]=Guid.NewGuid().ToString()),
        ("回执尚未确认",j=>Receipt(j)["result"]!["status"]="pending")
    ];
    foreach(var (name,corrupt) in corruptions){var invalid=Advance(identityInitial);corrupt(invalid);Refuses(()=>store.Commit(invalid),name+"拒绝提交");}
    Check(store.Read(identityInitial["session"]!["id"]!.GetValue<string>())!["session"]!["seq"]!.GetValue<int>()==0,"身份校验失败不推进持久化序号");
    var invalidFiles=new List<(string Path,string Content)>();
    foreach(var (_,corrupt) in corruptions){var invalid=Advance(Journal(Guid.NewGuid().ToString()));corrupt(invalid);var invalidPath=Path.Combine(root,"sessions",invalid["session"]!["id"]!.GetValue<string>()+".json");var content=invalid.ToJsonString();File.WriteAllText(invalidPath,content);invalidFiles.Add((invalidPath,content));}
    var loaded=store.Load();Check(loaded["errors"]!.AsArray().Count==corruptions.Length,"恢复时逐一拒绝不完整或错配身份的记录");
    Check(invalidFiles.All(file=>File.Exists(file.Path)&&File.ReadAllText(file.Path)==file.Content),"恢复拒绝后保留每份原始记录供核对");
    Check(loaded["journals"]!.AsArray().Any(j=>j!["session"]!["id"]!.GetValue<string>()==id),"异常记录不妨碍读取有效课堂");
    Check(JsonNode.DeepEquals(store.Commit(final)["receipts"],final["receipts"]),"课堂结束后丢回执重试仍返回原回执");
    var syncedBefore=store.Read(id)!["session"]!["seq"]!.GetValue<int>();store.MarkSynced(id,syncedBefore);
    Check(store.Read(id)!["session"]!["seq"]!.GetValue<int>()==syncedBefore&&store.Read(id)!["syncedSeq"]!.GetValue<int>()==syncedBefore,"同步元数据不推进业务序号且不丢回执");

    foreach(var exempt in new[]{false,true}){
        var seed=Journal(Guid.NewGuid().ToString());var questionId=Guid.NewGuid().ToString();var roundId=Guid.NewGuid().ToString();
        seed["session"]!["currentQuestionId"]=questionId;seed["session"]!["currentRoundId"]=roundId;
        seed["session"]!["questions"]=new JsonArray(new JsonObject{["id"]=questionId,["revision"]=1,["answer"]=null,["rounds"]=new JsonArray(new JsonObject{["id"]=roundId,["status"]="collecting",["answers"]=new JsonObject(),["exempt"]=exempt?new JsonArray("s1"):new JsonArray()})});
        store.Commit(seed);var sealedJournal=Advance(seed,"end_round");sealedJournal["session"]!["questions"]![0]!["rounds"]![0]!["status"]="closed";store.Commit(sealedJournal);
        var changed=Advance(sealedJournal,"set_exempt",new JsonObject{["studentId"]="s1",["exempt"]=!exempt});changed["session"]!["questions"]![0]!["rounds"]![0]!["exempt"]=exempt?new JsonArray():new JsonArray("s1");
        Refuses(()=>store.Commit(changed),exempt?"原生存储拒绝恢复已封存免答":"原生存储拒绝新增已封存免答");
        var annotation=Advance(sealedJournal,"edit_question",new JsonObject{["revision"]=1,["answer"]="B"});annotation["session"]!["questions"]![0]!["answer"]="B";annotation["session"]!["questions"]![0]!["revision"]=2;store.Commit(annotation);
        Check(store.Read(seed["session"]!["id"]!.GetValue<string>())!["session"]!["questions"]![0]!["answer"]!.GetValue<string>()=="B","封存保护仍允许补标准答案");
    }
    var beforeReceiptMetadata=store.Read(id)!.DeepClone();var deliveredSeq=beforeReceiptMetadata["session"]!["seq"]!.GetValue<int>();
    store.SaveCache("receipt-"+id,new JsonObject{["seq"]=deliveredSeq});
    Check(new CardQuizStore(root,"c1","d1").LoadCache("receipt-"+id)?["seq"]?.GetValue<int>()==deliveredSeq&&JsonNode.DeepEquals(store.Read(id),beforeReceiptMetadata),"回执送达进度独立持久化且整个业务 Journal 不变");

    // Snapshots represent model-confirmed state; the store preserves it, rather than replaying business rules.
    JsonObject Round(JsonObject journal) => journal["session"]!["questions"]![0]!["rounds"]![0]!.AsObject();
    void PublicMultiState(JsonObject journal, string activeOption, int received) {
        var state = journal["receipts"]!.AsObject().Last().Value!["result"]!["state"]!;
        state["questionType"] = "multiple"; state["activeOption"] = activeOption;
        state["received"] = received; state["optionReceived"] = 1;
    }
    foreach (var allFalse in new[] { false, true }) {
        var multiId = Guid.NewGuid().ToString(); var questionId = Guid.NewGuid().ToString(); var roundId = Guid.NewGuid().ToString();
        var multi = Journal(multiId); var s = multi["session"]!;
        s["cardVersion"] = "ice-v1"; s["currentQuestionId"] = questionId; s["currentRoundId"] = roundId;
        s["questions"] = new JsonArray(new JsonObject {
            ["id"] = questionId, ["type"] = "multiple", ["revision"] = 1, ["answer"] = allFalse ? "A" : "AC",
            ["options"] = allFalse ? new JsonArray("甲", "乙") : new JsonArray("甲", "乙", "丙", "丁"),
            ["rounds"] = new JsonArray(new JsonObject { ["id"] = roundId, ["status"] = "collecting", ["generation"] = 1,
                ["activeOption"] = "A", ["answers"] = new JsonObject(), ["exempt"] = new JsonArray() })
        });
        store.Commit(multi);
        multi = Advance(multi, "answer", new JsonObject { ["cardNumber"] = 1, ["option"] = allFalse ? "B" : "A", ["targetOption"] = "A" });
        Round(multi)["answers"]!["s1"] = new JsonObject { ["choices"] = new JsonObject { ["A"] = !allFalse },
            ["option"] = allFalse ? "" : "A", ["confirmedAt"] = 1001, ["seq"] = 1 };
        PublicMultiState(multi, "A", 0); store.Commit(multi);
        var partial = new CardQuizStore(root, "c1", "d1").Read(multiId)!;
        Check(Round(partial)["answers"]!["s1"]!["choices"]!.AsObject().Count == 1 &&
            !Round(partial)["answers"]!["s1"]!["choices"]!.AsObject().ContainsKey("B"), "多选部分作答重启后缺项仍为缺项而非不选");
        var priorReceipts = partial["receipts"]!.DeepClone();
        multi = Advance(multi, "set_multi_option", new JsonObject { ["option"] = "B" });
        Round(multi)["activeOption"] = "B"; Round(multi)["generation"] = 2;
        PublicMultiState(multi, "B", 0); multi["receipts"]!.AsObject().Last().Value!["result"]!["state"]!["optionReceived"] = 0;
        store.Commit(multi);
        var switched = store.Read(multiId)!;
        Check(Round(switched)["activeOption"]!.GetValue<string>() == "B" &&
            switched["session"]!["generation"]!.GetValue<int>() == 2 && Round(switched)["generation"]!.GetValue<int>() == 2,
            "set_multi_option 确认提交并保留当前收答项及新代次");
        Check(JsonNode.DeepEquals(switched["receipts"]![priorReceipts.AsObject().First().Key], priorReceipts.AsObject().First().Value),
            "换项不会改写部分作答的历史回执");
        multi = Advance(multi, "answer", new JsonObject { ["cardNumber"] = 1, ["option"] = "B", ["targetOption"] = "B" });
        Round(multi)["answers"]!["s1"]!["choices"]!["B"] = false;
        Round(multi)["answers"]!["s1"]!["confirmedAt"] = 1003; Round(multi)["answers"]!["s1"]!["seq"] = 3;
        PublicMultiState(multi, "B", allFalse ? 1 : 0); store.Commit(multi);
        if (!allFalse) {
            foreach (var (target, selected, seq) in new[] { ("C", true, 5), ("D", false, 7) }) {
                multi = Advance(multi, "set_multi_option", new JsonObject { ["option"] = target });
                Round(multi)["activeOption"] = target; Round(multi)["generation"] = multi["session"]!["generation"]!.DeepClone();
                PublicMultiState(multi, target, 0); multi["receipts"]!.AsObject().Last().Value!["result"]!["state"]!["optionReceived"] = 0;
                store.Commit(multi);
                multi = Advance(multi, "answer", new JsonObject { ["cardNumber"] = 1, ["option"] = selected ? "A" : "B", ["targetOption"] = target });
                Round(multi)["answers"]!["s1"]!["choices"]![target] = selected;
                Round(multi)["answers"]!["s1"]!["option"] = "AC";
                Round(multi)["answers"]!["s1"]!["confirmedAt"] = 1000 + seq; Round(multi)["answers"]!["s1"]!["seq"] = seq;
                PublicMultiState(multi, target, target == "D" ? 1 : 0); store.Commit(multi);
            }
        }
        var restarted = new CardQuizStore(root, "c1", "d1");
        var complete = restarted.Load()["journals"]!.AsArray().Single(j => j!["session"]!["id"]!.GetValue<string>() == multiId)!.AsObject();
        var answer = Round(complete)["answers"]!["s1"]!;
        Check(answer["option"]!.GetValue<string>() == (allFalse ? "" : "AC") &&
            JsonNode.DeepEquals(answer["choices"], JsonNode.Parse(allFalse ? "{\"A\":false,\"B\":false}" : "{\"A\":true,\"B\":false,\"C\":true,\"D\":false}")) &&
            answer["seq"]!.GetValue<int>() == (allFalse ? 3 : 7) && answer["confirmedAt"]!.GetValue<int>() == (allFalse ? 1003 : 1007),
            allFalse ? "完整全不选重启恢复为空选项且保留所有 false 确认" : "完整 AC 重启恢复逐项选择与确认时间序号");
        Check(complete["receipts"]!.AsObject().Last().Value!["result"]!["state"]!["received"]!.GetValue<int>() == 1 &&
            complete["receipts"]!.AsObject().First().Value!["result"]!["state"]!["received"]!.GetValue<int>() == 0,
            "部分到完整的公开计数保留各自原回执");
        Check(JsonNode.DeepEquals(restarted.Commit(multi), complete), "多选完整 Journal 重试返回原持久记录");
        var changed = multi.DeepClone().AsObject(); Round(changed)["activeOption"] = "A";
        Refuses(() => restarted.Commit(changed), "多选同序号换项覆盖拒绝");
        changed = multi.DeepClone().AsObject(); Round(changed)["answers"]!["s1"]!["choices"]!["B"] = true;
        Refuses(() => restarted.Commit(changed), "多选同序号选择覆盖拒绝");
        changed = Advance(multi, "set_multi_option", new JsonObject { ["option"] = "A" });
        Receipt(changed)["result"]!["state"]!["optionReceived"] = 99;
        Refuses(() => restarted.Commit(changed), "多选追加事件不能改写历史公开回执");
        changed = Advance(multi, "set_multi_option", new JsonObject { ["option"] = "A" });
        changed["events"]![0]!["payload"]!["targetOption"] = "B"; ChangeCommand(changed, c => c["payload"]!["targetOption"] = "B");
        Refuses(() => restarted.Commit(changed), "多选历史事件即使指纹同步修改也不能覆盖");
        var mismatched = Advance(multi, "set_multi_option", new JsonObject { ["option"] = "A" });
        mismatched["events"]!.AsArray().Last()!["payload"]!["option"] = "B";
        Refuses(() => restarted.Commit(mismatched), "新换项动作仍验证事件与指纹一致");
        Refuses(() => restarted.Commit(Advance(multi, "set_multi_options", new JsonObject { ["option"] = "A" })), "允许新动作不会放行未知动作");
        var closed = Advance(multi, "end_round"); Round(closed)["status"] = "closed"; Round(closed)["endedAt"] = 2000; restarted.Commit(closed);
        changed = Advance(closed, "set_multi_option", new JsonObject { ["option"] = "A" }); Round(changed)["activeOption"] = "A";
        Refuses(() => restarted.Commit(changed), "已封存多选轮次不能换项改写");
        changed = Advance(closed, "edit_question"); Round(changed)["answers"]!["s1"]!["choices"]!["B"] = true;
        Refuses(() => restarted.Commit(changed), "已封存多选轮次不能改写选择");
        var annotation = Advance(closed, "edit_question", new JsonObject { ["revision"] = 1, ["answer"] = "B" });
        annotation["session"]!["questions"]![0]!["answer"] = "B"; annotation["session"]!["questions"]![0]!["revision"] = 2;
        restarted.Commit(annotation);
        Check(JsonNode.DeepEquals(Round(restarted.Read(multiId)!), Round(closed)), "补标准答案仍保留封存多选轮次及全部选择");
    }
    foreach (var type in new[] { "single", "boolean" }) {
        var legacyId = Guid.NewGuid().ToString(); var legacy = Journal(legacyId);
        var questionId = Guid.NewGuid().ToString(); var roundId = Guid.NewGuid().ToString();
        legacy["session"]!["currentQuestionId"] = questionId; legacy["session"]!["currentRoundId"] = roundId;
        legacy["session"]!["questions"] = new JsonArray(new JsonObject { ["id"] = questionId, ["type"] = type,
            ["options"] = new JsonArray("甲", "乙"), ["answer"] = "B", ["rounds"] = new JsonArray(new JsonObject {
                ["id"] = roundId, ["status"] = "collecting", ["answers"] = new JsonObject(), ["exempt"] = new JsonArray() }) });
        store.Commit(legacy); legacy = Advance(legacy, "answer", new JsonObject { ["cardNumber"] = 1, ["option"] = "B" });
        Round(legacy)["answers"]!["s1"] = new JsonObject { ["option"] = "B", ["confirmedAt"] = 1001, ["seq"] = 1 }; store.Commit(legacy);
        var restored = new CardQuizStore(root, "c1", "d1").Load()["journals"]!.AsArray().Single(j => j!["session"]!["id"]!.GetValue<string>() == legacyId)!;
        Check(JsonNode.DeepEquals(restored, legacy) && !Round(restored.AsObject()).ContainsKey("activeOption") &&
            !Round(restored.AsObject())["answers"]!["s1"]!.AsObject().ContainsKey("choices") && !restored["events"]![0]!["payload"]!.AsObject().ContainsKey("targetOption"),
            "旧 " + type + " 作答与载入保持原形状且无需多选字段");
    }
    Console.WriteLine($"CardQuizChecks: {count} passed");
}catch(Exception error){Console.Error.WriteLine(error);Environment.ExitCode=1;}
finally{Console.WriteLine("Retained test journal: "+root);}
