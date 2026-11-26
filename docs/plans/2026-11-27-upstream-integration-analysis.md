# 涓婃父鏁村悎鍒嗘瀽锛圥0锛?
鏃ユ湡 2026-11-27銆傚熀绾匡細`upstream/main d104d9ca`锛?20 涓彁浜わ紝棰嗗厛鎴戜滑鐨勫熀鐐?`218a6bd0`锛夈€傛湰鏂囦欢鍙仛鍒嗘瀽锛屼笉鏀逛唬鐮併€?
## 1. 涓婃父浠诲姟绯荤粺瀹為檯缁撴瀯

`ds-bot/src/host/bot-tasks.js`锛?,445 琛岋級鏄畬鏁寸殑鍚庡彴浠诲姟绯荤粺锛?
- 浠诲姟璁板綍瀛樺湪 `bot.tasks[]`锛屽瓧娈碉細id/title/brief/status/sessionId/segments/startedAt/endedAt/summary/reportFile/error/roomId/workId銆?- `startTask()`锛?56 琛岋級鏍￠獙鏍囬/绠€鎶?鐩綍锛屾瀯閫?`baseTask`锛岀劧鍚庤皟鐢?**`rt.openTaskPart(bot, fromSessionId, baseTask, {workDir})`** 鍒涘缓鎵ц Session锛?37 琛岋級銆?- `parts.js:2187 openTaskPart()` 浼樺厛 `sessionController.fork()`锛屽惁鍒?`rt.createSession()`锛涢殢鍚?`freshRoute`/`selectRoute` 閫夋ā鍨嬨€乣applyPermission` 搴旂敤鏉冮檺锛屽啓鍏?`bot.tasks`銆乣chatOwners`銆乣taskOwners`銆?- 鍚姩鏂瑰紡锛歚rt.deliver({toId: bot.id, sessionId, text: prompt, role:'task', taskId})`锛?51 琛岋級锛屽嵆鎶婄畝鎶ヤ綔涓轰竴鏉′换鍔℃秷鎭姇閫掑埌璇?Session銆?- 缁撶畻锛歚ctx.on('session/event')` 鍦?`turn/end` 鏃惰皟鐢?`settleTask()`锛?193鈥?260 琛岋級锛屽啓鍏?completed/failed/stopped锛岀敓鎴?summary/reportFile锛岄€氱煡鍓嶅彴锛岃Е鍙?`task.*` 浜嬩欢銆?- 宸ュ叿闈細`task_start`銆乣task_send`銆乣task_stop`銆乣task_list`銆乣task_read`锛?308鈥?400 琛岋級锛屽彟鏈?`taskPage` UI 涓?`/api/bot` 绔偣銆?- 宸叉湁鑳藉姏锛氱兢/鎴块棿浠诲姟銆両M 鏉ユ簮銆佸鎵瑰啋娉°€乭andoff work銆侀噸鍚悗 interrupted 瀵硅处銆佸凡瀹屾垚浠诲姟瑁佸壀锛堜笂闄?50锛夈€?
缁撹锛氫笂娓告妸鈥滀换鍔♀€濆畾涔変负涓€涓?*鏅€?Bot Session 鐨勪竴娆″彈鎺?turn**锛屼笉鏄嫭绔嬫墽琛屽涓汇€?
## 2. pstack 闇€瑕佷粈涔?
鎴戜滑鐨?`task-executor.js` 鎻愪緵涓婃父娌℃湁鐨勫洓浠朵簨锛?
1. **鎵ц瀹夸富**锛坄task-host-*`锛夛細涓嶆帹鐞嗐€佷笉鎵ц宸ュ叿锛屽彧鎸佹湁璋冪敤鑰呯簿纭?preset revision銆?2. **worker**锛氱户鎵?caller preset 鐨勫伐绋嬪伐鍏枫€佹枃浠?鎼滅储/Shell锛屽甫鐙珛鐨?sandbox/approval锛屽伐鍏峰悕 ceiling锛坅dmission 鍐荤粨锛夈€?3. **pstack 缁戝畾**锛歴ourceRoot銆乻ettings銆乸reflight銆佹簮鍚堝悓璇诲彇銆?4. **缁堟€佸洖鏀?*锛氫换鍔＄粨鏉熼噴鏀?host/worker entries 涓?preset 寮曠敤锛圔 鎻愪氦锛夈€?
涓婃父 `openTaskPart` 鍒涘缓鐨勬槸 Bot 鑷繁鐨?Session锛屾ā鍨?鏉冮檺鏉ヨ嚜 Bot锛屼笉鍏峰 1/2/3銆?
## 3. 鍙€夋暣鍚堟柟妗?
### 鏂规 A锛氳繍琛屾椂鎺ョ紳瑕嗙洊锛堜笉鏀逛笂娓告簮鐮侊級

pstack 妯″潡鍦?`botTasks` 涔嬪悗瀹夎锛屽寘瑁呬袱涓姩鎬佽皟鐢ㄧ偣锛?
- `rt.openTaskPart`锛歱stack Bot 鐨勪换鍔℃敼涓哄垱寤?host+worker锛堟垜浠殑 executor锛夛紝鎶?worker sessionId 鍐欏叆 `bot.tasks`/`taskOwners`锛岃繑鍥?`{sessionId, forked:false, task}`銆?- `rt.deliver`锛氬璇?task session 鐨?`role:'task'` 鎶曢€掓敼涓哄惎鍔?executor锛坆rief 鍗?prompt锛夛紝涓嶅啀璧版櫘閫?Bot turn銆?- 缁撶畻娌跨敤涓婃父 `session/event` 鐨?turn/end锛歸orker 鐨?turn/end 浼氳Е鍙?`settleTask`锛屾姤鍛?閫氱煡/UI 鍏ㄩ儴澶嶇敤銆?
浼樼偣锛氶浂涓婃父琛ヤ竵锛屽崌绾у啿绐佸皬銆?椋庨櫓锛氫緷璧栦笂娓稿唴閮ㄨ皟鐢ㄩ『搴忎笌 `rt.deliver` 璇箟锛沗task_send`/`task_stop`/閲嶅惎瀵硅处闇€瑕侀€愪竴鏄犲皠鍒?executor 鐨?steer/cancel/interrupted锛涗笂娓歌嫢鏀瑰姩杩欎袱涓帴缂濓紝閫傞厤灞傝璺熻繘銆?
### 鏂规 B锛氫笂娓告樉寮忔墿灞曠偣锛堝皬琛ヤ竵锛?
鍦?`startTask` 澧炲姞 `rt.taskRunners` 娉ㄥ唽琛細鍛戒腑 runner 鏃剁敱 runner 杩斿洖 `{sessionId, done}`锛宐otTasks 鍦?`done` 鏃?`settleTask`锛屼笉鍐嶄緷璧?`deliver`/turn-end銆?
浼樼偣锛氬绾︽竻鏅帮紝娴嬭瘯瀹规槗锛涗笂娓稿彧澧炲姞绾?30 琛屻€?椋庨櫓锛氶渶瑕佺淮鎶や竴涓笂娓歌ˉ涓侊紱浣嗘瘮鍖呰鍐呴儴璇箟绋炽€?
### 鏂规 C锛氶噸鍐?botTasks锛堜笉鎺ㄨ崘锛?
鎶婁笂娓?1,445 琛屽鍒舵敼閫狅紝闀挎湡璺熶笂娓稿垎鍙夛紝杩濊儗鈥滀互涓婃父涓哄熀鍑嗏€濄€?
## 4. 鎺ㄨ崘

**P1 鍏堝仛鏂规 A 鐨勫彲琛屾€у師鍨?*锛堥浂琛ヤ竵锛夛紝鐢ㄤ袱涓祴璇曢拤浣忥細

- pstack Bot 璋?`task_start` 鈫?executor 鍒涘缓 host/worker 鈫?worker 瀹屾垚 鈫?涓婃父 `settleTask` 浜х敓 completed + summary锛?- `task_stop` 鈫?executor.cancel 鈫?涓婃父 stopped銆?
鑻?A 鍦?`deliver`/缁撶畻椤哄簭涓婁笉鍙潬锛屽啀鍗囩骇涓?**鏂规 B**锛堟樉寮?`taskRunners` 琛ヤ竵锛夈€備袱鑰呴兘浠モ€滀笂娓?UI/宸ュ叿/鐢熷懡鍛ㄦ湡 + pstack 鎵ц寮曟搸鈥濅负杈圭晫锛屼笉鍐嶄繚鐣欐垜浠殑 `task-runs` 骞惰绯荤粺銆?
## 5. 鏂囦欢涓庡伐浣滈噺

| 鍖哄煙 | 澶勭悊 |
|---|---|
| `src/host/pstack-models.js` | 鐩存帴绉绘锛屼綆鍐茬獊 |
| `src/host/pstack.js` | 绉绘 source binding/preflight锛岄€傞厤涓婃父 `capabilities.js` 鐨?`loaded` map |
| `src/host/task-executor.js` | 淇濈暀涓哄唴閮ㄦ墽琛屽紩鎿庯紝鍘绘帀瀵规棫 `task-runs` 妯″潡鐨勪緷璧?|
| `src/host/task-runs.js` | 閫€褰癸紱宸ュ叿闈㈡敼鐢ㄤ笂娓?`task_*`锛岀鐐?UI 鐢ㄤ笂娓?`taskPage` |
| `src/host/bot-tasks.js` | 鏂规 A 涓嶆敼锛涙柟妗?B 鍔?runner 閽╁瓙 |
| `src/client/*` | 鍒犻櫎鎴戜滑鐨?task-runs UI锛屾部鐢ㄤ笂娓镐换鍔?UI锛沗client.js` 閲嶆柊鐢熸垚 |
| `test/*` | 绉绘 executor/preset/tool-policy 娴嬭瘯锛屾柊澧?botTasks+pstack 闆嗘垚娴嬭瘯 |

棰勪及锛氭柟妗?A 鍘熷瀷 1鈥? 澶╋紱瀹屾暣鏇挎崲涓庢祴璇?3鈥? 澶╋紱涓嶅惈涓婃父鍚庣画鍙樺姩銆?
## 6. 鍏抽敭椋庨櫓

1. **缁撶畻璇箟**锛氫笂娓镐互 turn/end 缁撶畻锛沞xecutor 鐨?worker 鏄惁绋冲畾浜х敓鍚屽悕浜嬩欢銆侀敊璇?鍙栨秷鏄惁鏄犲皠姝ｇ‘銆?2. **鏉冮檺**锛氫笂娓?`applyPermission` 鎸?Bot/鎴块棿锛沺stack 鎸夎皟鐢ㄨ€?preset + 浠诲姟 permission锛岄渶閬垮厤鍙岄噸鏀剁揣鎴栨斁瀹姐€?3. **妯″瀷閫夋嫨**锛氫笂娓?`freshRoute` 涓轰换鍔?Session 閫?Bot 妯″瀷锛沺stack 瑕佹眰 caller preset 鐨?exact revision锛屼簩鑰呴渶鏄庣‘璋佷紭鍏堛€?4. **task_send/steer**锛氫笂娓?`deliverToTask` 璧?`rt.deliver` 鍒颁换鍔?Session锛沞xecutor 鐨?steer 鏄彟涓€鏉¤矾寰勩€?5. **閲嶅惎瀵硅处**锛氫笂娓告妸鏈畬鎴愪换鍔℃爣 interrupted锛沞xecutor 鐨勭粨鏋滄槸鍚︽寔涔呭寲銆佽兘鍚︽仮澶嶃€?6. **鐢熸垚鏂囦欢**锛歚client.js` 蹇呴』閲嶅缓锛屼笉鑳芥墜鏀?106 澶勫啿绐併€?
## 7. P0 閫€鍑烘潯浠?
- 閫夊畾 A 鎴?B锛屽苟鍐欏嚭 runner/鎺ョ紳鐨勬帴鍙ｈ崏鍥撅紱
- 鍒楀嚭蹇呴』鏂板/淇敼鐨勬祴璇曪紱
- 涓嶆敼浠讳綍浠ｇ爜锛岀瓑寰呭疄鏂芥寚浠ゃ€?