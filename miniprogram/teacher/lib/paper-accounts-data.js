'use strict';
// Teacher-only contracts in server/student_accounts.py; no student or device authentication.
const integer = (value, min = 0, max = 2147483647) => Number.isInteger(value) && value >= min && value <= max;
const fail = message => { throw new Error(message); };
function identifier(value) {
  return typeof value === 'string' && value.trim() && Array.from(value).length <= 128 && !value.startsWith('data:') &&
    !Array.from(value).some(char => { const code = char.codePointAt(0); return code < 32 || code >= 0xd800 && code <= 0xdfff; });
}
const classCode = value => typeof value === 'string' && /^[123](0[1-9]|[1-9][0-9])$/.test(value);
function versions(state) {
  if (!state || ['revision', 'rosterRevision', 'cardRevision'].some(key => !integer(state[key]))) fail('账号、名单或卡号版本无效，请重新读取。');
  return { revision: state.revision, rosterRevision: state.rosterRevision, cardRevision: state.cardRevision };
}
function readAccounts(source, classId) {
  if (!source || source.classId !== classId || !identifier(classId) || typeof source.className !== 'string' || typeof source.canEdit !== 'boolean' ||
      !(source.classCode === null || classCode(source.classCode)) || !Array.isArray(source.students) || source.students.length > 300)
    fail('班级学生账号响应不完整，请重新读取。');
  const revision = versions(source), seen = new Set(), cards = new Set();
  // Whitelist non-secret fields: a read snapshot must never cache credentials.
  const students = source.students.map(row => {
    if (!row || !identifier(row.studentId) || seen.has(row.studentId) || typeof row.name !== 'string' || typeof row.activeHere !== 'boolean' ||
        !(row.cardNumber === null || integer(row.cardNumber, 1, 157)) || row.cardNumber !== null && cards.has(row.cardNumber)) fail('学生账号名单响应不完整或重复，请重新读取。');
    seen.add(row.studentId); if (row.cardNumber !== null) cards.add(row.cardNumber);
    if (row.accountId === null ? row.username !== null || row.accountRevision !== null || row.activeHere :
      !identifier(row.accountId) || !identifier(row.username) || !integer(row.accountRevision, 1)) fail('学生账号关联状态不完整，请重新读取。');
    return { studentId: row.studentId, name: row.name, cardNumber: row.cardNumber, accountId: row.accountId,
      username: row.username, accountRevision: row.accountRevision, activeHere: row.activeHere };
  });
  return { classId, className: source.className, classCode: source.classCode, ...revision, canEdit: source.canEdit, students };
}
function rows(state, selectedIds) {
  const selected = new Set(selectedIds);
  return state.students.map(student => ({ studentId: student.studentId, name: student.name, username: student.username || '尚未关联',
    resettable: Boolean(student.accountId && student.activeHere), selected: selected.has(student.studentId),
    status: student.accountId ? student.activeHere ? '当前关联' : '保留历史关联' : student.cardNumber === null ? '待分配卡号' : '待生成或关联' }));
}
function action(state, kind, input) {
  if (!state || state.canEdit !== true) fail('当前账号没有管理本班学生账号的权限。');
  const data = versions(state), className = '「' + state.className + '」';
  let targets, title, content, confirmText, suffix = '';
  if (kind === 'generate') {
    const year = String(input.entryYear).trim(), code = String(input.classCode).trim();
    if (!/^20[0-9]{2}$/.test(year)) fail('入学年份须为 2000-2099 的整数。');
    if (!classCode(code)) fail('班级编码须为三位数字，如高一（9）班为 109。');
    targets = state.students.filter(student => student.cardNumber !== null && student.accountId === null);
    if (!targets.length) fail('当前没有已分配卡号且未关联的学生，请先核对纸卡设置。');
    Object.assign(data, { entryYear: Number(year), classCode: code });
    title = '生成本班学生账号'; confirmText = '确认生成';
    content = '将为' + className + '已分配卡号且未关联的 ' + targets.length + ' 人生成账号，入学年份 ' + year + '，首次发放班级编码 ' + code +
      '。已有账号不覆盖。初始密码仅本次显示，页面隐藏或离开即清除，请在本页完成核对。';
  } else if (kind === 'reset') {
    const ids = input.studentIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 157 || new Set(ids).size !== ids.length) fail('请选择 1-157 名不重复的当前关联学生。');
    targets = ids.map(id => state.students.find(student => student.studentId === id));
    if (targets.some(student => !student || !student.accountId || !student.activeHere)) fail('只能重置当前关联本班名单的学生账号，请核对转班情况。');
    data.studentIds = ids.slice(); suffix = '/reset'; title = '重置所选学生密码'; confirmText = '确认重置';
    content = '将重置' + className + '所选 ' + targets.length + ' 人（' + targets.slice(0, 5).map(student => student.name).join('、') +
      (targets.length > 5 ? '等' : '') + '）的密码。旧密码及旧学生会话立即失效，新密码仅本次返回，页面隐藏或离开即清除。';
  } else if (kind === 'link') {
    const student = state.students.find(row => row.studentId === input.studentId), username = String(input.username || '').trim();
    if (!student || student.accountId) fail('请明确选择本班尚未关联账号的学生，不能覆盖已有账号或历史。');
    if (!/^[0-9]{1,32}$/.test(username)) fail('请填写原学生账号的完整数字编号，最多 32 位。');
    targets = [student]; Object.assign(data, { studentId: student.studentId, username }); suffix = '/link'; title = '关联原学生账号'; confirmText = '确认关联';
    content = '将' + className + '的「' + student.name + '」关联到原账号 ' + username + '。需同时拥有原班与本班管理权限，由服务端核验。原账号、密码和历史保留，不按姓名或卡号猜测身份。';
  } else fail('不支持的学生账号操作。');
  return { kind, suffix, data, targets: targets.map(student => student.studentId), title, content, confirmText };
}
function readResult(source, before, plan) {
  const state = readAccounts(source, before.classId);
  if (state.revision !== before.revision + 1 || state.rosterRevision !== before.rosterRevision || state.cardRevision !== before.cardRevision)
    fail('操作返回的账号、名单或卡号版本无法核对。');
  if (plan.kind === 'link') {
    const student = state.students.find(row => row.studentId === plan.data.studentId);
    if (!student || !student.activeHere || !student.accountId || student.username !== plan.data.username || source.credentials && source.credentials.length)
      fail('关联结果无法核对。');
    return { state, credentials: [] };
  }
  if (!state.canEdit || !Array.isArray(source.credentials) || source.credentials.length !== plan.targets.length) fail('本次密码结果不完整，请重新读取账号状态核对。');
  const seen = new Set();
  const credentials = source.credentials.map(row => {
    const student = row && state.students.find(item => item.studentId === row.studentId);
    if (!student || seen.has(row.studentId) || !plan.targets.includes(row.studentId) || row.classId !== state.classId ||
        !student.activeHere || row.accountId !== student.accountId || row.username !== student.username || row.cardNumber !== student.cardNumber ||
        typeof row.password !== 'string' || !/^[0-9]{6}$/.test(row.password)) fail('本次密码身份或内容无法核对，已停止展示。');
    seen.add(row.studentId);
    return { studentId: row.studentId, name: student.name, username: row.username, password: row.password };
  });
  return { state, credentials };
}

module.exports = { versions, readAccounts, rows, action, readResult };
