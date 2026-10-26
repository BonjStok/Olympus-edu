"""Local verification of the replacement manifest and the reviewed batch.

No database, network, content mutation or Judge0 requests. This is additional
evidence; it does not replace the project's content compiler or quality gates.
Exit 2 means that the 360-task replacement is incomplete. --allow-incomplete
permits inspecting a partial batch, but the JSON report still says complete=false.
"""

import argparse
import contextlib
import csv
import hashlib
import io
import itertools
import json
import re
import subprocess
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def digest(task):
    return hashlib.sha256(json.dumps(task, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def read_kind(kind):
    return [record for path in sorted((ROOT/'content'/kind).rglob('*.json'))
            for record in json.loads(path.read_text(encoding='utf-8'))]


def normalize(text):
    return '\n'.join(line.rstrip(' \t') for line in text.replace('\r\n', '\n').split('\n')).rstrip()


def run_reference(case):
    task, index, sample = case
    try:
        run = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-c', task['solution']],
                             input=sample['input'], capture_output=True, encoding='utf-8', timeout=5)
        if run.returncode != 0 or normalize(run.stdout) != normalize(sample['output']):
            return {'taskId': task['id'], 'test': index+1, 'returnCode': run.returncode,
                    'expected': sample['output'], 'actual': run.stdout, 'stderr': run.stderr}
    except (subprocess.TimeoutExpired, OSError) as error:
        return {'taskId': task['id'], 'test': index+1, 'error': str(error)}
    return None


def desks_oracle(text):
    counts = list(map(int, text.split()))
    assert len(counts) == 3 and all(1 <= x <= 1000 for x in counts)
    # Fill actual seats; independent of the reference's ceiling formula.
    total = 0
    for children in counts:
        while children > 0:
            children -= 2
            total += 1
    return str(total)


def ring_oracle(text):
    v, t = map(int, text.split())
    assert -100 <= v <= 100 and 0 <= t <= 1000
    # Simulate one-kilometre moves, with explicit wrap, without %.
    position = 0
    for _ in range(abs(v)*t):
        position += 1 if v > 0 else -1
        if position == 109:
            position = 0
        if position == -1:
            position = 108
    return str(position)


def snail_oracle(text):
    h, a, b = map(int, text.split())
    assert 1 <= h <= 10000 and 1 <= a <= 10000 and 0 <= b < a
    height, day = 0, 0
    # Simulate days; no rounding formula and no night after reaching the top.
    while True:
        day += 1
        height += a
        if height >= h:
            return str(day)
        height -= b


ORACLES = {'info-5-02-task-3': desks_oracle,
           'info-5-02-task-4': ring_oracle,
           'info-5-02-task-5': snail_oracle}


def execute_reviewed(code, text):
    # Only the three newly authored, hash-bound reference programs use this
    # fast in-process differential loop. All 96 references also run as children
    # with a five-second timeout on every stored test.
    saved_stdin = sys.stdin
    output = io.StringIO()
    try:
        sys.stdin = io.StringIO(text)
        with contextlib.redirect_stdout(output):
            exec(code, {'__name__': '__main__'})
    finally:
        sys.stdin = saved_stdin
    return normalize(output.getvalue())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-incomplete', action='store_true')
    args = parser.parse_args()
    baseline = json.loads((ROOT/'docs/task-replacement/baseline.json').read_text(encoding='utf-8'))
    reviewed = json.loads((ROOT/'docs/task-replacement/reviewed.json').read_text(encoding='utf-8'))
    with (ROOT/'docs/task-sources.csv').open(encoding='utf-8-sig', newline='') as stream:
        registry = list(csv.DictReader(stream))
    topics, tasks, mocks = read_kind('topics'), read_kind('tasks'), read_kind('mock-tests')
    by_id = {task['id']: task for task in tasks}
    old_by_id = {task['taskId']: task for task in baseline['tasks']}
    registry_by_id = {row['taskId']: row for row in registry}
    errors = []

    def check(ok, message):
        if not ok:
            errors.append(message)

    check(len(tasks) == len(by_id) == len(old_by_id) == 360, 'Expected exactly 360 unique tasks')
    check(set(by_id) == set(old_by_id), 'Task IDs differ from the original manifest')
    check(Counter(t['type'] for t in tasks) == {'number': 264, 'code': 96}, 'Wrong type totals')
    check(len(registry) == len(registry_by_id) == 360 and set(registry_by_id) == set(by_id),
          'Source registry must cover every task exactly once')
    expected_groups = {'math-4': (60, 0), 'math-5': (60, 0), 'math-6': (60, 0),
                       'info-4': (36, 24), 'info-5': (24, 36), 'info-6': (24, 36)}
    groups = {}
    for group, (numbers, codes) in expected_groups.items():
        records = [t for t in tasks if t['id'].startswith(group+'-')]
        groups[group] = dict(total=len(records), number=sum(t['type']=='number' for t in records),
                             code=sum(t['type']=='code' for t in records))
        check(groups[group] == dict(total=60, number=numbers, code=codes), f'Wrong distribution: {group}')
    changed = []
    for file in baseline['files']:
        records = json.loads((ROOT/file).read_text(encoding='utf-8'))
        before = [t for t in baseline['tasks'] if t['file'] == file]
        check([t['id'] for t in records] == [t['taskId'] for t in before], f'Order changed in {file}')
        for task in records:
            old = old_by_id.get(task['id'])
            if old is None:
                continue
            for field in ['type', 'topicId', 'order']:
                check(task.get(field) == old[field], f'{task["id"]}: changed {field}')
            if digest(task) != old['sha256']:
                changed.append(task['id'])
    check(set(changed) == set(reviewed), 'Changed tasks are not exactly the reviewed batch')
    for task_id, record in reviewed.items():
        task = by_id.get(task_id)
        check(task is not None and digest(task) == record['sha256'], f'{task_id}: stale review')
        row = registry_by_id.get(task_id, {})
        check(row.get('status') == 'replaced_local', f'{task_id}: wrong provenance status')
        check(row.get('type') == task.get('type'), f'{task_id}: registry type differs')
        for key in ['sourceTitle', 'sourceAuthor', 'problemNumber', 'pageOrSection', 'sourceUrl',
                    'conditionAdaptation', 'solutionSource', 'hintSource', 'usageTerms', 'ageAssessment']:
            check(bool(row.get(key, '').strip()), f'{task_id}: missing {key}')
        check(str(row.get('sourceUrl', '')).startswith('https://'), f'{task_id}: source must use HTTPS')
    for row in registry:
        check((row['status'] == 'replaced_local') == (row['taskId'] in reviewed),
              f'{row["taskId"]}: unsupported provenance claim')
    topic_rows = []
    for topic in topics:
        records = [t for t in tasks if t['topicId'] == topic['id']]
        check(len(records) == 5, f'{topic["id"]}: expected five tasks')
        check(len({t['order'] for t in records}) == 5, f'{topic["id"]}: duplicated order')
        topic_rows.append(dict(topicId=topic['id'], title=topic['title'],
                               types=[t['type'] for t in records],
                               replaced=sum(t['id'] in reviewed for t in records)))
    for task in tasks:
        for field in ['title', 'prompt', 'hint', 'solution']:
            check(bool(task.get(field, '').strip()), f'{task["id"]}: missing {field}')
        if task['type'] == 'number':
            check(re.fullmatch(r'[-+]?\d+(?:[.,]\d+)?', str(task.get('answer', ''))) is not None,
                  f'{task["id"]}: not a single numeric answer')
        else:
            check(3 <= len(task.get('tests', [])) <= 20, f'{task["id"]}: test count')
            check(task.get('example') == task['tests'][0], f'{task["id"]}: example differs from test 1')
    for mock in mocks:
        ids = mock['taskIds']
        check(len(ids) == len(set(ids)), f'{mock["id"]}: duplicate tasks')
        for task_id in ids:
            task = by_id.get(task_id)
            check(task is not None and task['grade'] == mock['grade'] and task['subject'] == mock['subject'],
                  f'{mock["id"]}: broken link {task_id}')
    fixtures = json.loads((ROOT/'test-data.json').read_text(encoding='utf-8'))
    numeric = fixtures['numericTask']
    check(by_id[numeric['id']]['answer'] == numeric['correctAnswer'], 'Stale numericTask fixture')
    for task_id, answer in fixtures['mockAnswers'].items():
        check(by_id[task_id]['answer'] == answer, f'{task_id}: stale mock answer')

    # Independent enumeration, not copying answers from solution text.
    cities = range(100)
    roads = {tuple(sorted((i, (i+d) % 100))) for i in cities for d in [1, 2]}
    check(all(sum(i in road for road in roads) == 4 for i in cities), 'Road witness is invalid')
    numeric_results = {
        'info-5-02-task-1': str(53 - 7*max(q for q in range(54) if 7*q <= 53)),
        'info-5-02-task-2': str(int(str(4706)[-2])),
        'math-5-06-task-1': str(len(list(itertools.product('ОР', repeat=3)))),
        'math-5-06-task-2': str(len(list(itertools.permutations(range(11), 2)))),
        'math-5-06-task-3': str(len(list(itertools.permutations(range(5))))),
        'math-5-06-task-4': str(len(list(itertools.combinations(range(6), 2)))),
        'math-5-06-task-5': str(len(roads)),
    }
    for task_id, answer in numeric_results.items():
        task = by_id[task_id]
        check(task['answer'] == answer, f'{task_id}: independent numeric answer differs')
        check(task['solution'].rstrip().endswith('Ответ: '+answer+'.'), f'{task_id}: solution result differs')
        if task_id.startswith('info-'):
            code = re.search(r'```python\n(.*?)\n```', task['prompt'], re.S).group(1)
            result = subprocess.run([sys.executable, '-I', '-X', 'utf8', '-c', code],
                                    capture_output=True, encoding='utf-8', timeout=5)
            check(result.returncode == 0 and normalize(result.stdout) == answer,
                  f'{task_id}: code in numeric prompt differs')
    independent_tests = 0
    for task_id, oracle in ORACLES.items():
        for sample in by_id[task_id]['tests']:
            check(oracle(sample['input']) == sample['output'], f'{task_id}: oracle rejects stored output')
            independent_tests += 1
    differential_cases = {
        'info-5-02-task-3': ['\n'.join(map(str, items))+'\n' for items in itertools.product(range(1, 9), repeat=3)],
        'info-5-02-task-4': [f'{v}\n{t}\n' for v in range(-12, 13) for t in range(21)],
        'info-5-02-task-5': [f'{h}\n{a}\n{b}\n' for h in range(1, 31) for a in range(1, 11) for b in range(a)],
    }
    differential_count = 0
    # Do not execute an altered program in-process after its review became stale.
    if not errors:
        for task_id, inputs in differential_cases.items():
            code = compile(by_id[task_id]['solution'], task_id, 'exec')
            for text in inputs:
                check(execute_reviewed(code, text) == ORACLES[task_id](text),
                      f'{task_id}: differential mismatch for {text!r}')
                differential_count += 1
    cases = [(task, index, sample) for task in tasks if task['type'] == 'code'
             for index, sample in enumerate(task['tests'])]
    with ThreadPoolExecutor(max_workers=8) as pool:
        failures = [failure for failure in pool.map(run_reference, cases) if failure]
    check(not failures, f'{len(failures)} reference test failures')
    incomplete = [task['id'] for task in tasks if task['id'] not in reviewed]
    report = dict(complete=not incomplete and not errors, taskCount=len(tasks), groups=groups,
                  topics=topic_rows, preservedTaskTypes=not any('changed type' in e for e in errors),
                  replaced=len(reviewed), pending=len(incomplete), pendingTaskIds=incomplete,
                  numericAnswersIndependentlyChecked=numeric_results,
                  referencesExecuted=sum(task['type']=='code' for task in tasks),
                  storedReferenceTestsExecuted=len(cases), storedReferenceTestFailures=failures,
                  newCodeTasksWithIndependentOracles=len(ORACLES),
                  newStoredOutputsIndependentlyChecked=independent_tests,
                  differentialCases=differential_count, mockTestsChecked=len(mocks),
                  errors=errors,
                  limits=['Human source review covers only the reviewed batch.',
                          'Passing stored tests is not independent proof for the 93 unchanged code tasks.',
                          'Numerical semantics of 257 unchanged number tasks have not been independently verified.',
                          'No live Judge0 service was contacted; resource compatibility is checked statically.'])
    (ROOT/'docs/task-replacement/verification.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({key: value for key, value in report.items()
                      if key not in ['topics','pendingTaskIds','numericAnswersIndependentlyChecked']},
                     ensure_ascii=True, indent=2))
    if errors:
        return 1
    return 0 if args.allow_incomplete or not incomplete else 2


if __name__ == '__main__':
    raise SystemExit(main())
