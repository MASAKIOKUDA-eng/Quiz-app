'use strict';

// API のベース URL。config.js の window.API_BASE を使い、末尾スラッシュは除去。
// 未設定（空文字）の場合は、同一オリジン `/api` を既定とする（app.js と同じ規約）。
var API_BASE = (typeof window.API_BASE === 'string' && window.API_BASE !== ''
  ? window.API_BASE
  : '/api'
).replace(/\/$/, '');

// Cognito Hosted UI の設定。config.js の window から読み込む。
// （FEAT-004 で Amplify の環境変数から config.js に注入される想定）
var COGNITO_DOMAIN = (typeof window.COGNITO_DOMAIN === 'string'
  ? window.COGNITO_DOMAIN
  : ''
).replace(/\/$/, '');
var COGNITO_CLIENT_ID =
  typeof window.COGNITO_CLIENT_ID === 'string' ? window.COGNITO_CLIENT_ID : '';

// このページ自身の URL（Hosted UI の redirect_uri / logout_uri に使う）。
// クエリやハッシュを除いた admin.html の URL。
var ADMIN_URL = window.location.origin + window.location.pathname;

// DOM 参照
var statusEl = document.getElementById('status');
var loginView = document.getElementById('login-view');
var adminView = document.getElementById('admin-view');
var loginBtn = document.getElementById('login-btn');
var logoutBtn = document.getElementById('logout-btn');
var adminForm = document.getElementById('admin-form');
var titleInput = document.getElementById('quiz-title-input');
var quizIdInput = document.getElementById('quiz-id-input');
var questionsEl = document.getElementById('admin-questions');
var addQuestionBtn = document.getElementById('add-question-btn');
var resultEl = document.getElementById('admin-result');

// メモリ上に保持する id_token とその有効期限（ミリ秒エポック）。
var idToken = null;
var tokenExpiresAt = 0;

var STORAGE_KEY = 'quizAdminToken';
var questionSeq = 0;

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

// ---- 認証まわり ---------------------------------------------------------

// 有効な（未期限切れの）id_token を持っているか。
function isAuthenticated() {
  return !!idToken && Date.now() < tokenExpiresAt;
}

// sessionStorage から復元（ページ再読み込み対策・任意）。
function restoreToken() {
  try {
    var raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    var saved = JSON.parse(raw);
    if (saved && saved.idToken && saved.expiresAt && Date.now() < saved.expiresAt) {
      idToken = saved.idToken;
      tokenExpiresAt = saved.expiresAt;
    } else {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch (e) {
    // sessionStorage が使えない環境でも動作させる。
  }
}

function saveToken() {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ idToken: idToken, expiresAt: tokenExpiresAt })
    );
  } catch (e) {
    // 保存できなくてもメモリ上のトークンで動作する。
  }
}

function clearToken() {
  idToken = null;
  tokenExpiresAt = 0;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // no-op
  }
}

// URL フラグメント（#id_token=...&access_token=...&expires_in=...）を解析。
// implicit grant のトークンを取得したら、フラグメントを URL から除去する。
function captureTokenFromHash() {
  var hash = window.location.hash || '';
  if (hash.charAt(0) === '#') {
    hash = hash.substring(1);
  }
  if (!hash) {
    return;
  }
  var params = new URLSearchParams(hash);
  var token = params.get('id_token');
  var expiresIn = params.get('expires_in');
  var oauthError = params.get('error');

  if (oauthError) {
    setStatus('ログインに失敗しました: ' + oauthError, true);
  }

  if (token) {
    idToken = token;
    var seconds = expiresIn ? parseInt(expiresIn, 10) : 3600;
    if (isNaN(seconds) || seconds <= 0) {
      seconds = 3600;
    }
    // 時計ずれ・遅延を考慮し 60 秒のマージンを取る。
    tokenExpiresAt = Date.now() + (seconds - 60) * 1000;
    saveToken();
  }

  if (token || oauthError) {
    // フラグメントを消してトークンを URL から見えなくする。
    history.replaceState(null, '', ADMIN_URL + window.location.search);
  }
}

function redirectToLogin() {
  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    setStatus(
      'Cognito の設定（COGNITO_DOMAIN / COGNITO_CLIENT_ID）が未設定です。config.js を確認してください。',
      true
    );
    return;
  }
  var url =
    COGNITO_DOMAIN +
    '/login?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&response_type=token' +
    '&scope=openid+email+profile' +
    '&redirect_uri=' +
    encodeURIComponent(ADMIN_URL);
  window.location.assign(url);
}

function redirectToLogout() {
  clearToken();
  if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
    render();
    return;
  }
  var url =
    COGNITO_DOMAIN +
    '/logout?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&logout_uri=' +
    encodeURIComponent(ADMIN_URL);
  window.location.assign(url);
}

// ---- 表示切り替え -------------------------------------------------------

function render() {
  var authed = isAuthenticated();
  loginView.hidden = authed;
  adminView.hidden = !authed;
  if (authed && questionsEl.children.length === 0) {
    addQuestionBlock();
  }
}

// ---- 問題ブロックの動的生成 ---------------------------------------------

function addQuestionBlock() {
  questionSeq += 1;
  var qid = questionSeq;

  var block = document.createElement('fieldset');
  block.className = 'admin-question';
  block.dataset.qid = String(qid);

  var legend = document.createElement('legend');
  legend.className = 'admin-question-legend';
  legend.textContent = '問題';
  block.appendChild(legend);

  // 問題文
  var textField = document.createElement('div');
  textField.className = 'admin-field';
  var textLabel = document.createElement('label');
  textLabel.textContent = '問題文';
  var textInput = document.createElement('input');
  textInput.type = 'text';
  textInput.className = 'admin-input question-text';
  textInput.placeholder = '例: S3 の説明として正しいものは？';
  textInput.autocomplete = 'off';
  textField.appendChild(textLabel);
  textField.appendChild(textInput);
  block.appendChild(textField);

  // 選択肢コンテナ（2〜4 個）
  var optionsWrap = document.createElement('div');
  optionsWrap.className = 'admin-options';
  block.appendChild(optionsWrap);

  var addOptionBtn = document.createElement('button');
  addOptionBtn.type = 'button';
  addOptionBtn.className = 'btn small';
  addOptionBtn.textContent = '選択肢を追加';
  addOptionBtn.addEventListener('click', function () {
    if (optionsWrap.querySelectorAll('.admin-option').length < 4) {
      addOptionRow(optionsWrap, qid);
    }
    updateOptionControls(block);
  });

  var removeQuestionBtn = document.createElement('button');
  removeQuestionBtn.type = 'button';
  removeQuestionBtn.className = 'btn small';
  removeQuestionBtn.textContent = 'この問題を削除';
  removeQuestionBtn.addEventListener('click', function () {
    block.parentNode.removeChild(block);
  });

  var controls = document.createElement('div');
  controls.className = 'admin-question-controls';
  controls.appendChild(addOptionBtn);
  controls.appendChild(removeQuestionBtn);
  block.appendChild(controls);

  // 初期選択肢 2 個
  addOptionRow(optionsWrap, qid);
  addOptionRow(optionsWrap, qid);
  updateOptionControls(block);

  questionsEl.appendChild(block);
}

function addOptionRow(optionsWrap, qid) {
  var row = document.createElement('div');
  row.className = 'admin-option';

  var radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'correct-' + qid;
  radio.className = 'option-correct';
  radio.title = '正解にする';

  var text = document.createElement('input');
  text.type = 'text';
  text.className = 'admin-input option-text';
  text.placeholder = '選択肢';
  text.autocomplete = 'off';

  var removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn small';
  removeBtn.textContent = '削除';
  removeBtn.addEventListener('click', function () {
    var block = optionsWrap.closest('.admin-question');
    if (optionsWrap.querySelectorAll('.admin-option').length > 2) {
      optionsWrap.removeChild(row);
      if (block) {
        updateOptionControls(block);
      }
    }
  });

  row.appendChild(radio);
  row.appendChild(text);
  row.appendChild(removeBtn);
  optionsWrap.appendChild(row);
}

// 選択肢が 2 個のときは削除ボタンを無効化する（最低 2 個保証）。
function updateOptionControls(block) {
  var rows = block.querySelectorAll('.admin-option');
  var disableRemove = rows.length <= 2;
  rows.forEach(function (row) {
    var btn = row.querySelector('.btn.small');
    if (btn) {
      btn.disabled = disableRemove;
    }
  });
}

// ---- フォーム収集・検証 -------------------------------------------------

// フォームから { title, questions, quizId? } を組み立てる。
// 検証エラーがある場合は例外を投げる（サーバ規則をミラー）。
function collectPayload() {
  var title = titleInput.value.trim();
  if (!title) {
    throw new Error('タイトルを入力してください。');
  }

  var blocks = questionsEl.querySelectorAll('.admin-question');
  if (blocks.length === 0) {
    throw new Error('問題を 1 つ以上追加してください。');
  }

  var questions = [];
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var qNo = i + 1;
    var text = block.querySelector('.question-text').value.trim();
    if (!text) {
      throw new Error('問題 ' + qNo + ' の問題文を入力してください。');
    }

    var optionInputs = block.querySelectorAll('.option-text');
    var options = [];
    for (var j = 0; j < optionInputs.length; j++) {
      var val = optionInputs[j].value.trim();
      if (val) {
        options.push(val);
      }
    }
    if (options.length < 2) {
      throw new Error(
        '問題 ' + qNo + ' には空でない選択肢を 2 つ以上入力してください。'
      );
    }

    // 正解ラジオ。選択肢のうち「空でない」ものの中でのインデックスを求める。
    var radios = block.querySelectorAll('.option-correct');
    var checkedDomIndex = -1;
    for (var k = 0; k < radios.length; k++) {
      if (radios[k].checked) {
        checkedDomIndex = k;
        break;
      }
    }
    if (checkedDomIndex === -1) {
      throw new Error('問題 ' + qNo + ' の正解を選択してください。');
    }
    // 空欄をスキップした options 配列に合わせて answerIndex を換算。
    var answerIndex = -1;
    var counter = 0;
    for (var m = 0; m < optionInputs.length; m++) {
      if (optionInputs[m].value.trim()) {
        if (m === checkedDomIndex) {
          answerIndex = counter;
          break;
        }
        counter++;
      }
    }
    if (answerIndex === -1) {
      throw new Error(
        '問題 ' + qNo + ' の正解は空でない選択肢を選んでください。'
      );
    }

    questions.push({ text: text, options: options, answerIndex: answerIndex });
  }

  var payload = { title: title, questions: questions };

  var quizId = quizIdInput.value.trim();
  if (quizId) {
    if (!/^[a-z0-9-]+$/.test(quizId)) {
      throw new Error(
        'クイズ ID は半角英小文字・数字・ハイフンのみ使用できます。'
      );
    }
    payload.quizId = quizId;
  }

  return payload;
}

// ---- API 呼び出し -------------------------------------------------------

// app.js の fetchJson を踏襲した helper。401/403 を日本語メッセージに変換。
async function postJson(path, body) {
  var res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + idToken,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401) {
    clearToken();
    render();
    throw new Error('ログインが必要です（認証エラー）');
  }
  if (res.status === 403) {
    throw new Error('権限がありません');
  }

  var contentType = res.headers.get('content-type') || '';
  var data = null;
  if (contentType.indexOf('application/json') !== -1) {
    data = await res.json();
  }

  if (!res.ok) {
    var message =
      data && data.message
        ? data.message
        : 'リクエストに失敗しました (' + res.status + ')';
    throw new Error(message);
  }

  if (data === null) {
    throw new Error(
      'API から予期しない応答を受け取りました（JSON ではありません）。'
    );
  }
  return data;
}

async function submitForm(event) {
  event.preventDefault();
  resultEl.hidden = true;
  resultEl.innerHTML = '';

  var payload;
  try {
    payload = collectPayload();
  } catch (err) {
    setStatus(err.message, true);
    return;
  }

  if (!isAuthenticated()) {
    setStatus('ログインが必要です（認証エラー）', true);
    render();
    return;
  }

  setStatus('登録中...');
  try {
    var result = await postJson('/admin/quizzes', payload);
    setStatus('');
    renderResult(result);
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderResult(result) {
  resultEl.hidden = false;
  resultEl.innerHTML = '';

  var heading = document.createElement('p');
  heading.className = 'admin-result-heading';
  heading.textContent = 'クイズを登録しました。';
  resultEl.appendChild(heading);

  var detail = document.createElement('p');
  detail.textContent =
    'クイズ ID: ' +
    (result.quizId || '') +
    ' / 問題数: ' +
    (typeof result.questionCount === 'number' ? result.questionCount : '');
  resultEl.appendChild(detail);

  var link = document.createElement('a');
  link.href = 'index.html';
  link.textContent = 'クイズアプリで確認する';
  resultEl.appendChild(link);
}

// ---- 初期化 -------------------------------------------------------------

loginBtn.addEventListener('click', redirectToLogin);
logoutBtn.addEventListener('click', redirectToLogout);
addQuestionBtn.addEventListener('click', addQuestionBlock);
adminForm.addEventListener('submit', submitForm);

restoreToken();
captureTokenFromHash();
render();
