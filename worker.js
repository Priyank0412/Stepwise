/* Stepwise worker: loads Pyodide (CPython in WebAssembly) and records a line-by-line trace. */
const BASE = new URL('pyodide/', self.location.href).href;
let py = null;

const TRACER = String.raw`
# PY_START
import sys, json, reprlib, traceback, builtins, types

class _Stop(BaseException):
    pass

_R = reprlib.Repr()
_R.maxlevel = 3
_R.maxlist = _R.maxtuple = _R.maxset = _R.maxfrozenset = _R.maxdeque = _R.maxarray = 12
_R.maxdict = 12
_R.maxstring = 100
_R.maxother = 100
_R.maxlong = 40

def _rep(v):
    try:
        if isinstance(v, types.FunctionType):
            return '<function %s>' % v.__name__
        if isinstance(v, type):
            return '<class %s>' % v.__name__
        if isinstance(v, types.ModuleType):
            return '<module %s>' % v.__name__
        t = type(v)
        if t.__repr__ is object.__repr__ and hasattr(v, '__dict__'):
            items = list(vars(v).items())[:8]
            return '%s(%s)' % (t.__name__, ', '.join('%s=%s' % (k, _R.repr1(x, 2)) for k, x in items))
        return _R.repr(v)
    except Exception:
        return '<unprintable %s>' % type(v).__name__

def _snap(d):
    out = []
    n = 0
    for k, v in list(d.items()):
        if not isinstance(k, str) or k.startswith('__') or k.startswith('.'):
            continue
        if isinstance(v, (types.FunctionType, types.ModuleType, type)):
            continue
        n += 1
        if n > 40:
            out.append(['...', '(more variables not shown)', ''])
            break
        out.append([k, _rep(v), type(v).__name__])
    return out

def _fmt_err(e, code):
    src = code.split('\n')
    out = ['Traceback (most recent call last):']
    last = None
    for fs in traceback.extract_tb(e.__traceback__):
        if fs.filename == '<user>':
            last = fs.lineno
            out.append('  line %d, in %s' % (fs.lineno, fs.name))
            if 0 < fs.lineno <= len(src):
                out.append('    ' + src[fs.lineno - 1].strip())
    try:
        msg = ''.join(traceback.format_exception_only(type(e), e)).strip()
    except Exception:
        msg = type(e).__name__
    out.append(msg)
    return {'text': '\n'.join(out), 'line': last or 1}

def _run(code, stdin_text, max_steps):
    steps = []
    state = {'trunc': False, 'n16': 0, 'cur': 0}
    chunks = []

    class _Out:
        encoding = 'utf-8'
        def write(self, s):
            s = str(s)
            chunks.append(s)
            state['n16'] += len(s.encode('utf-16-le', 'surrogatepass')) // 2
            return len(s)
        def flush(self):
            pass
        def isatty(self):
            return False

    out = _Out()
    frames = {}
    ids = [0]
    lines_in = stdin_text.split('\n') if stdin_text else []

    def fake_input(prompt=''):
        out.write(str(prompt))
        if not lines_in:
            raise EOFError('EOF when reading a line: add text in the Program input box')
        s = lines_in.pop(0)
        out.write(s + '\n')
        return s

    bi = dict(vars(builtins))
    bi['input'] = fake_input
    g = {'__name__': '__main__', '__builtins__': bi}

    try:
        co = compile(code, '<user>', 'exec')
    except SyntaxError as e:
        return json.dumps({'steps': [], 'out': '', 'trunc': False,
                           'err': {'text': '%s: %s' % (type(e).__name__, e.msg), 'line': e.lineno or 1}})
    except Exception as e:
        return json.dumps({'steps': [], 'out': '', 'trunc': False,
                           'err': {'text': '%s: %s' % (type(e).__name__, e), 'line': 1}})

    def tracer(frame, event, arg):
        c = frame.f_code
        if c.co_filename != '<user>':
            return None
        if event == 'call':
            state['cur'] += 1
            if id(frame) not in frames:
                ids[0] += 1
                frames[id(frame)] = ids[0]
            return tracer
        if event not in ('line', 'return', 'exception'):
            return tracer
        if event == 'exception' and issubclass(arg[0], _Stop):
            return tracer
        fid = frames.get(id(frame), 0)
        depth = state['cur'] - 1
        if event == 'return':
            state['cur'] -= 1
            frames.pop(id(frame), None)
            if steps and steps[-1]['e'] == 'e' and steps[-1]['fi'] == fid:
                return tracer  # the exception is unwinding this frame, not a normal return
        if len(steps) >= max_steps:
            state['trunc'] = True
            raise _Stop()
        stack = []
        f = frame
        while f is not None and len(stack) < 30:
            if f.f_code.co_filename == '<user>':
                stack.append([f.f_code.co_name, f.f_lineno])
            f = f.f_back
        if depth + 1 > len(stack):
            stack.append(['... %d more' % (depth + 1 - len(stack)), 0])
        s = {'l': frame.f_lineno, 'e': event[0], 'fi': fid, 'd': depth, 'st': stack,
             'v': _snap(frame.f_locals), 'o': state['n16']}
        if c.co_name != '<module>':
            s['g'] = _snap(frame.f_globals)
        if event == 'return':
            s['r'] = _rep(arg)
        elif event == 'exception':
            try:
                s['x'] = '%s: %s' % (arg[0].__name__, arg[1])
            except Exception:
                s['x'] = arg[0].__name__
        steps.append(s)
        return tracer

    old = (sys.stdout, sys.stderr)
    sys.stdout = sys.stderr = out
    err = None
    sys.settrace(tracer)
    try:
        exec(co, g)
    except _Stop:
        pass
    except SystemExit:
        pass
    except BaseException as e:
        err = _fmt_err(e, code)
    finally:
        sys.settrace(None)
        sys.stdout, sys.stderr = old
    return json.dumps({'steps': steps, 'out': ''.join(chunks), 'err': err, 'trunc': state['trunc']})
# PY_END
`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The standard library ships as base64 inside a JSON file (archives can't be hosted as-is).
// Pyodide asks for python_stdlib.zip by URL, so answer that one request from memory.
async function provideStdlib() {
  const res = await fetch(BASE + 'python_stdlib.json');
  if (!res.ok) throw new Error('Could not download the Python standard library (HTTP ' + res.status + ')');
  const bytes = b64ToBytes((await res.json()).zip);
  const realFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (/python_stdlib\.zip(\?|#|$)/.test(url)) {
      return Promise.resolve(new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/zip' } }));
    }
    return realFetch(input, init);
  };
}

async function init() {
  try {
    postMessage({ type: 'status', message: 'Downloading the Python runtime (about 14 MB, first visit only)' });
    await provideStdlib();
    importScripts(BASE + 'pyodide.js');
    postMessage({ type: 'status', message: 'Starting Python' });
    py = await loadPyodide({ indexURL: BASE });
    py.runPython(TRACER);
    postMessage({ type: 'ready' });
  } catch (err) {
    postMessage({ type: 'fatal', message: String((err && err.message) || err) });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'run' || !py) return;
  try {
    py.globals.set('_u_code', m.code);
    py.globals.set('_u_stdin', m.stdin || '');
    py.globals.set('_u_max', m.max);
    const data = py.runPython('_run(_u_code, _u_stdin, _u_max)');
    postMessage({ type: 'result', data });
  } catch (err) {
    postMessage({ type: 'fatal', message: String((err && err.message) || err) });
  }
};

init();
