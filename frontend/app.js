'use strict';

// API のベース URL。config.js の window.API_BASE を使い、末尾スラッシュは除去。
var API_BASE = (window.API_BASE || '').replace(/\/$/, '');

var statusEl = document.getElementById('status');
var listView = document.getElementById('quiz-list-view');
var quizView = document.getElementById('quiz-view');
var resultView = document.getElementById('result-view');
var quizListEl = document.getElementById('quiz-list');
var quizTitleEl = document.getElementById('quiz-title');
var questionsEl = document.getElementById('questions');
var quizForm = document.getElementById('quiz-form');
var scoreEl = document.getElementById('score');
var resultDetailEl = document.getElementById('result-detail');

var currentQuiz = null;

function setStatus(message, isError) {
  statusEl.textContent = message || '';
  statusEl.classList.toggle('error', !!isError);
}

function show(view) {
  listView.hidden = view !== 'list';
  quizView.hidden = view !== 'quiz';
  resultView.hidden = view !== 'result';
}

function apiUrl(path) {
  return API_BASE + path;
}

async function fetchJson(path, options) {
  var res = await fetch(apiUrl(path), options);
  if (!res.ok) {
    throw new Error('リクエストに失敗しました (' + res.status + ')');
  }
  return res.json();
}

async function loadQuizzes() {
  setStatus('クイズを読み込み中...');
  try {
    var data = await fetchJson('/quizzes');
    renderQuizList(data.quizzes || []);
    setStatus('');
    show('list');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderQuizList(quizzes) {
  quizListEl.innerHTML = '';
  if (quizzes.length === 0) {
    quizListEl.innerHTML = '<li>クイズがありません。</li>';
    return;
  }
  quizzes.forEach(function (quiz) {
    var li = document.createElement('li');
    var btn = document.createElement('button');
    btn.className = 'btn quiz-item';
    btn.textContent = quiz.title + '（全' + quiz.questionCount + '問）';
    btn.addEventListener('click', function () {
      loadQuiz(quiz.quizId);
    });
    li.appendChild(btn);
    quizListEl.appendChild(li);
  });
}

async function loadQuiz(quizId) {
  setStatus('問題を読み込み中...');
  try {
    currentQuiz = await fetchJson('/quizzes/' + encodeURIComponent(quizId));
    renderQuiz(currentQuiz);
    setStatus('');
    show('quiz');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderQuiz(quiz) {
  quizTitleEl.textContent = quiz.title;
  questionsEl.innerHTML = '';
  quiz.questions.forEach(function (q) {
    var fieldset = document.createElement('fieldset');
    fieldset.className = 'question';

    var legend = document.createElement('legend');
    legend.textContent = 'Q' + (q.n + 1) + '. ' + q.text;
    fieldset.appendChild(legend);

    q.options.forEach(function (option, optIdx) {
      var label = document.createElement('label');
      label.className = 'option';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'q' + q.n;
      input.value = String(optIdx);

      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + option));
      fieldset.appendChild(label);
    });

    questionsEl.appendChild(fieldset);
  });
}

async function submitAnswers(event) {
  event.preventDefault();
  if (!currentQuiz) {
    return;
  }
  var answers = currentQuiz.questions.map(function (q) {
    var checked = quizForm.querySelector('input[name="q' + q.n + '"]:checked');
    return checked ? Number(checked.value) : -1;
  });

  setStatus('採点中...');
  try {
    var result = await fetchJson(
      '/quizzes/' + encodeURIComponent(currentQuiz.quizId) + '/submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers: answers }),
      }
    );
    renderResult(result);
    setStatus('');
    show('result');
  } catch (err) {
    setStatus(err.message, true);
  }
}

function renderResult(result) {
  scoreEl.textContent =
    '正解数: ' + result.score + ' / ' + result.total;
  resultDetailEl.innerHTML = '';
  (result.results || []).forEach(function (r) {
    var li = document.createElement('li');
    li.textContent = 'Q' + (r.n + 1) + ': ' + (r.correct ? '正解' : '不正解');
    li.className = r.correct ? 'correct' : 'incorrect';
    resultDetailEl.appendChild(li);
  });
}

document.getElementById('back-btn').addEventListener('click', function () {
  show('list');
});
document.getElementById('restart-btn').addEventListener('click', function () {
  loadQuizzes();
});
quizForm.addEventListener('submit', submitAnswers);

loadQuizzes();
