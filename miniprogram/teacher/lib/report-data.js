'use strict';

// Field names and denominators follow server/card_quiz_sessions.py, homework.py and reading.py.
const SUBJECTS = [
  { id: '', name: '全部学科' },
  { id: 'chinese', name: '语文' }, { id: 'math', name: '数学' },
  { id: 'english', name: '英语' }, { id: 'physics', name: '物理' },
  { id: 'chemistry', name: '化学' }, { id: 'biology', name: '生物' },
  { id: 'politics', name: '政治' }, { id: 'history', name: '历史' },
  { id: 'geography', name: '地理' }
];
const STATUS = {
  correct: '正确', wrong: '错误', incomplete: '未完成', unanswered: '未答',
  exempt: '免答', ungraded: '未判定', practice: '练习'
};
const MODES = { classic: '兔拔萝卜', carving: '诗词镌刻', particle: '粒子浮雕', rocket: '火箭升空' };
const SYNC = { current: '已同步', pending: '待补传', review: '待核实', unconfirmed: '待同步确认' };
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const numberText = value => numeric(value) ? String(value) : '未提供';
const subjectName = id => (SUBJECTS.find(subject => subject.id === id) || {}).name || id;
const fractionText = (value, empty = '未判定') => numeric(value) ? (value * 100).toFixed(1) + '%' : empty;

function metric(key, label, value) {
  return { key, label, value: numberText(value) };
}

function paperMetrics(row, multiple = false, accuracy = row.accuracy) {
  const fields = [
    ['samples', '判定样本'], ['correct', '正确'], ['wrong', '错误'],
    ...(multiple || Object.prototype.hasOwnProperty.call(row, 'incomplete') ? [['incomplete', '未完成']] : []),
    ['unanswered', '未答'], ['exempt', '免答'], ['ungraded', '未判定'], ['practice', '练习']
  ];
  return fields.map(([key, label]) => metric(key, label, row[key])).concat({
    key: 'accuracy', label: '已答正确率', value: fractionText(accuracy)
  });
}

function completeAnswer(student, question) {
  if (question.type === 'multiple') {
    return question.options.every((_, i) => typeof (student.choices || {})['ABCD'[i]] === 'boolean');
  }
  return typeof student.option === 'string' && student.option.length > 0;
}

function answerText(student, question) {
  if (question.type === 'multiple') {
    if (completeAnswer(student, question)) return student.option || '全不选';
    if (!Object.keys(student.choices || {}).length) return '未收到作答';
    return question.options.map((_, i) => {
      const letter = 'ABCD'[i], choice = student.choices[letter];
      return letter + ' ' + (choice === true ? '选' : choice === false ? '不选' : '未答');
    }).join(' · ');
  }
  if (!student.option) return '未收到作答';
  if (question.type === 'boolean') {
    if (student.option === 'A') return 'A（正确）';
    if (student.option === 'B') return 'B（错误）';
  }
  return student.option;
}

function paperSessions(payload, formatTime) {
  if (!Array.isArray(payload.sessions)) throw new Error('课堂列表响应不完整，请重新载入。');
  return payload.sessions.slice().sort((a, b) => b.startedAt - a.startedAt || String(b.id).localeCompare(String(a.id))).map(row => ({
    id: row.id, classId: row.classId, subjectName: subjectName(row.subjectId),
    startedText: formatTime(row.startedAt),
    statusText: row.endedAt === null ? '尚未结束' : '已结束',
    questionCount: numberText(row.questionCount), studentCount: numberText(row.studentCount)
  }));
}

function paperDetail(payload, formatTime) {
  const session = payload.session, report = payload.report;
  if (!session || !Array.isArray(session.questions) || !Array.isArray(session.roster) || !report || !report.totals ||
      !Array.isArray(report.questions) || !Array.isArray(report.students)) {
    throw new Error('课堂统计响应不完整，请重新载入。');
  }
  const multiple = session.questions.some(q => q.type === 'multiple');
  const questions = report.questions.map((question, index) => {
    const snapshot = session.questions.find(q => q.id === question.id);
    if (!snapshot || !Array.isArray(snapshot.options) || !Array.isArray(question.rounds)) {
      throw new Error('课堂题目快照不完整，请重新载入。');
    }
    const official = question.rounds.filter(r => r.status === 'closed' && r.purpose === 'formal').slice(-1)[0];
    return {
      id: question.id, number: index + 1,
      text: question.text || (snapshot.imageId ? '图片题，请结合课堂题目查看。' : '课件临时题，未录入题干。'),
      hasImage: Boolean(snapshot.imageId),
      typeName: { single: '单选', boolean: '判断（A 正确，B 错误）', multiple: '多选' }[snapshot.type],
      multiple: snapshot.type === 'multiple',
      answerText: question.answer === null ? '未设置标准答案' : '标准答案 ' + question.answer,
      tagsText: question.tags.join('、'),
      options: snapshot.options.map((text, i) => ({ letter: 'ABCD'[i], text: text || '选项无文字' })),
      rounds: question.rounds.map((round, i) => {
        const closed = round.status === 'closed';
        const completed = closed ? round.students.filter(s => s.status !== 'exempt' && completeAnswer(s, snapshot)).length : 0;
        const expected = closed ? session.roster.length - round.exempt : 0;
        const accuracy = round.purpose === 'practice' ? null : round.samples ? round.correct / round.samples : null;
        const metrics = closed ? paperMetrics(round, snapshot.type === 'multiple', accuracy) : [];
        if (closed && round.purpose === 'practice') metrics[metrics.length - 1].value = '练习不计入正式正确率';
        return {
          id: round.id, number: i + 1, closed,
          label: '第 ' + (i + 1) + ' 轮 · ' + (round.purpose === 'practice' ? '练习' : '正式') + ' · ' +
            ({ closed: '已封存', paused: '已暂停', collecting: '收答中' }[round.status] || round.status),
          contribution: round.purpose === 'practice' ? '练习单独计数' : official && official.id === round.id ? '计入本课正式汇总' : closed ? '历史正式轮次，不计入本课汇总' : '封存后显示统计',
          participationText: closed ? completed + '/' + expected + '（' + (expected ? fractionText(completed / expected) : '无应答人数') + '）' : '',
          metrics,
          distribution: closed ? snapshot.options.map((text, optionIndex) => {
            const letter = 'ABCD'[optionIndex], count = round.distribution[letter];
            return { letter, text: text || '选项无文字', count: numberText(count),
              percent: completed && numeric(count) ? fractionText(count / completed) : '暂无作答' };
          }) : [],
          students: closed ? round.students.map(s => ({
            id: s.studentId, name: s.studentName,
            answerText: answerText(s, snapshot), statusText: STATUS[s.status] || s.status
          })) : []
        };
      })
    };
  });
  return {
    header: {
      id: session.id, classId: session.classId, subjectName: subjectName(session.subjectId),
      startedText: formatTime(session.startedAt),
      statusText: session.endedAt === null ? '尚未结束，仅显示已封存轮次' : '已结束',
      metrics: paperMetrics(report.totals, multiple)
    },
    questions,
    students: report.students.map(s => ({ id: s.studentId, name: s.studentName, metrics: paperMetrics(s, multiple) }))
  };
}

function homeworkReport(payload, formatTime) {
  if (!payload.totals || !Array.isArray(payload.rows) || !['assignments', 'students'].includes(payload.group) ||
      !Number.isInteger(payload.total) || payload.total < 0 || !Number.isInteger(payload.page) || payload.page < 1 ||
      !Number.isInteger(payload.pageSize) || payload.pageSize < 1) {
    throw new Error('作业报表响应不完整，请重新查询。');
  }
  const totals = payload.totals;
  const rate = numeric(totals.expected) && numeric(totals.submitted)
    ? totals.expected ? fractionText(totals.submitted / totals.expected) : '无应交' : '未提供';
  return {
    group: payload.group,
    metrics: [metric('assignments', '已登记作业（项）', totals.assignments),
      metric('expected', '应交（人次）', totals.expected), metric('submitted', '已交（人次）', totals.submitted),
      metric('missing', '未交（人次）', totals.missing), metric('noHomework', '无作业（项）', totals.noHomework),
      { key: 'rate', label: '上交率', value: rate }],
    rows: payload.rows.map((row, index) => ({
      key: (payload.page - 1) * payload.pageSize + index,
      className: row.className, termName: row.termName,
      ...(payload.group === 'students' ? { name: row.studentName } : {
        name: row.itemName, date: row.date, subjectName: row.subjectName,
        statusText: { submitted: '已登记', no_homework: '今日无作业' }[row.status] || row.status,
        missingNamesText: row.status === 'no_homework' ? '无需上交' : row.missing === 0 ? '无' :
          row.missingNames.length ? row.missingNames.join('、') : '未提供',
        updatedText: formatTime(row.updatedAt)
      }),
      expected: numberText(row.expected), submitted: numberText(row.submitted), missing: numberText(row.missing)
    })),
    page: payload.page, pages: Math.max(1, Math.ceil(payload.total / payload.pageSize)), total: payload.total
  };
}

function duration(seconds) {
  return numeric(seconds) ? Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒' : '未提供';
}

function completedMetrics(completed) {
  return [['carrots', '萝卜（颗）'], ['poems', '诗词（篇）'], ['badges', '徽章（次）'],
    ['launches', '发射（次）'], ['energy', '能量（格）']].map(([key, label]) => metric(key, label, completed[key]));
}

function readingReport(payload, formatTime) {
  if (!Array.isArray(payload.rows) || !Array.isArray(payload.daily)) throw new Error('早读报表响应不完整，请重新查询。');
  return {
    rows: payload.rows.map(row => ({
      classId: row.classId, className: row.className,
      metrics: [metric('sessions', '使用次数', row.sessions), metric('days', '使用天数', row.days),
        { key: 'active', label: '运行时长', value: duration(row.activeSeconds) },
        { key: 'effective', label: '有效发声', value: duration(row.effectiveSeconds) },
        { key: 'ratio', label: '达标占比', value: numeric(row.ratio) ? row.ratio.toFixed(1) + '%' : '暂无运行记录' }],
      modesText: row.modes.map(mode => MODES[mode] || mode).join('、') || '暂无模式记录',
      completed: completedMetrics(row.completed),
      noActivity: row.activeSeconds === 0,
      syncLabel: SYNC[row.sync.state] || '同步状态未提供',
      syncNote: { current: '', pending: '仍有离线记录待补传，当前统计可能不完整。',
        review: '仍有记录待核实，当前统计可能不完整。',
        unconfirmed: '尚未确认设备最新同步状态，不能据此判断未开展早读。' }[row.sync.state] || '请刷新核对设备同步状态。',
      syncedText: row.sync.lastSyncedAt === null ? '尚无同步确认' : formatTime(row.sync.lastSyncedAt),
      pendingText: numberText(row.sync.pendingBatches), reviewText: numberText(row.sync.reviewBatches)
    })),
    daily: payload.daily.map((row, index) => ({
      key: index, day: row.day, className: row.className,
      sessions: numberText(row.sessions), activeText: duration(row.activeSeconds), effectiveText: duration(row.effectiveSeconds),
      completed: completedMetrics(row.completed)
    }))
  };
}

function dateRangeError(start, end, maxDifference) {
  const parse = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const time = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
  };
  const first = parse(start), last = parse(end);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return '请选择有效的开始和结束日期。';
  if (first > last) return '开始日期不能晚于结束日期。';
  if ((last - first) / 86400000 > maxDifference) return '日期范围过长，请缩小后查询。';
  return '';
}

function paginate(rows, requestedPage, pageSize = 30) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(pages, Math.max(1, requestedPage));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pages, total: rows.length };
}

function nextRead(page) {
  page._generation = (page._generation || 0) + 1;
  return page._generation;
}
function currentRead(page, generation) {
  return page._visible === true && page._generation === generation;
}
// loadClasses also calls setData: guard that write, not just its returned promise.
function classReadTarget(page, generation) {
  return { get data() { return page.data; }, setData(patch) { if (currentRead(page, generation)) page.setData(patch); } };
}

function shareFile(runtime, filePath, fileName) {
  return new Promise((resolve, reject) => {
    if (typeof runtime.shareFileMessage !== 'function') {
      reject(new Error('当前微信版本不支持文件分享，请更新微信后重试。'));
      return;
    }
    runtime.shareFileMessage({ filePath, fileName, success: () => resolve(true), fail: error => {
      if (/cancel/i.test(error.errMsg || '')) resolve(false);
      else reject(new Error('文件分享失败，请重试。'));
    } });
  });
}

module.exports = {
  SUBJECTS, numberText, fractionText, completeAnswer, answerText, paperMetrics, paperSessions, paperDetail,
  homeworkReport, readingReport, duration, dateRangeError, paginate, nextRead, currentRead, classReadTarget, shareFile
};
