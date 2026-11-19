var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// security-worker/node_modules/.pnpm/sql.js@1.16.0/node_modules/sql.js/dist/sql-wasm-browser.js
var require_sql_wasm_browser = __commonJS({
  "security-worker/node_modules/.pnpm/sql.js@1.16.0/node_modules/sql.js/dist/sql-wasm-browser.js"(exports, module) {
    var initSqlJsPromise = void 0;
    var initSqlJs2 = function(moduleConfig) {
      if (initSqlJsPromise) {
        return initSqlJsPromise;
      }
      initSqlJsPromise = new Promise(function(resolveModule, reject) {
        var Module = typeof moduleConfig !== "undefined" ? moduleConfig : {};
        var originalOnAbortFunction = Module["onAbort"];
        Module["onAbort"] = function(errorThatCausedAbort) {
          reject(new Error(errorThatCausedAbort));
          if (originalOnAbortFunction) {
            originalOnAbortFunction(errorThatCausedAbort);
          }
        };
        Module["postRun"] = Module["postRun"] || [];
        Module["postRun"].push(function() {
          resolveModule(Module);
        });
        module = void 0;
        var k;
        k ||= typeof Module !== "undefined" ? Module : {};
        var aa = !!globalThis.window, ba = !!globalThis.WorkerGlobalScope;
        k.onRuntimeInitialized = function() {
          function a(f, h) {
            mb(f, h instanceof Error ? h.message : String(h), -1);
          }
          function b(f, h) {
            switch (typeof h) {
              case "boolean":
                ic(f, h ? 1 : 0);
                break;
              case "number":
                jc(f, h);
                break;
              case "string":
                kc(f, h, l(h), -1);
                break;
              case "object":
                if (h === null) nb(f);
                else if (h.length != null) {
                  var p = ca(h.length);
                  v.set(h, p);
                  lc(f, p, h.length, -1);
                  da(p);
                } else mb(f, "Wrong API use : tried to return a value of an unknown type (" + h + ").", -1);
                break;
              default:
                nb(f);
            }
          }
          function d(f, h) {
            for (var p = [], r = 0; r < f; r += 1) {
              var u = y(
                h + 4 * r,
                "i32"
              ), w = mc(u);
              if (w === 1 || w === 2) u = nc(u);
              else if (w === 3) w = ob(u), u = oc(u), u = A(u, w, true);
              else if (w === 4) {
                w = u;
                u = ob(w);
                w = pc(w);
                for (var x = new Uint8Array(u), G = 0; G < u; G += 1) x[G] = v[w + G];
                u = x;
              } else u = null;
              p.push(u);
            }
            return p;
          }
          function c(f, h) {
            this.Va = f;
            this.db = h;
            this.Ta = 1;
            this.Eb = [];
          }
          function e(f, h) {
            this.db = h;
            this.tb = ea(f);
            if (this.tb === null) throw Error("Unable to allocate memory for the SQL string");
            this.zb = this.tb;
            this.fb = this.Kb = null;
          }
          function g(f) {
            this.filename = "dbfile_" + (4294967295 * Math.random() >>> 0);
            f != null && fa(
              this.filename,
              f
            );
            this.handleError(F(this.filename, q));
            this.db = y(q, "i32");
            z && qc(this.db);
            this.Bb = {};
            this.ab = /* @__PURE__ */ new Map();
          }
          function m(f, h) {
            return f.replace(/[A-Z]/g, function(p) {
              return p.toLowerCase();
            }) + ":" + h;
          }
          function t(f) {
            f.forEach(ja);
          }
          var z = k.useOldExtensionFunctions !== false, q = ka(4), n = k.cwrap, F = n("sqlite3_open", "number", ["string", "number"]), S = n("sqlite3_close_v2", "number", ["number"]), Oa = n("sqlite3_backup_init", "number", ["number", "string", "number", "string"]), ma = n("sqlite3_backup_step", "number", ["number", "number"]), na = n(
            "sqlite3_backup_finish",
            "number",
            ["number"]
          ), ha = n("sqlite3_exec", "number", ["number", "number", "number", "number", "number"]), za = n("sqlite3_changes", "number", ["number"]), N = n("sqlite3_sql", "string", ["number"]), rc = n("sqlite3_normalized_sql", "string", ["number"]), Pa = n("sqlite3_prepare_v2", "number", ["number", "number", "number", "number", "number"]), sc = n("sqlite3_bind_text", "number", ["number", "number", "number", "number", "number"]), qb = n("sqlite3_bind_blob", "number", ["number", "number", "number", "number", "number"]), tc = n(
            "sqlite3_bind_double",
            "number",
            ["number", "number", "number"]
          ), uc = n("sqlite3_bind_int", "number", ["number", "number", "number"]), vc = n("sqlite3_bind_parameter_index", "number", ["number", "string"]), wc = n("sqlite3_step", "number", ["number"]), ia = n("sqlite3_errmsg", "string", ["number"]), xc = n("sqlite3_column_count", "number", ["number"]), yc = n("sqlite3_data_count", "number", ["number"]), zc = n("sqlite3_column_double", "number", ["number", "number"]), Ac = n("sqlite3_column_text", "number", ["number", "number"]), Bc = n("sqlite3_column_blob", "number", [
            "number",
            "number"
          ]), rb = n("sqlite3_column_bytes", "number", ["number", "number"]), Cc = n("sqlite3_column_type", "number", ["number", "number"]), Dc = n("sqlite3_column_name", "string", ["number", "number"]), Ec = n("sqlite3_reset", "number", ["number"]), Fc = n("sqlite3_clear_bindings", "number", ["number"]), Gc = n("sqlite3_finalize", "number", ["number"]), sb = n("sqlite3_create_function_v2", "number", "number string number number number number number number number".split(" ")), mc = n("sqlite3_value_type", "number", ["number"]), ob = n(
            "sqlite3_value_bytes",
            "number",
            ["number"]
          ), oc = n("sqlite3_value_text", "number", ["number"]), pc = n("sqlite3_value_blob", "number", ["number"]), nc = n("sqlite3_value_double", "number", ["number"]), jc = n("sqlite3_result_double", "", ["number", "number"]), nb = n("sqlite3_result_null", "", ["number"]), kc = n("sqlite3_result_text", "", ["number", "string", "number", "number"]), lc = n("sqlite3_result_blob", "", ["number", "number", "number", "number"]), ic = n("sqlite3_result_int", "", ["number", "number"]), mb = n("sqlite3_result_error", "", ["number", "string", "number"]), tb = n("sqlite3_aggregate_context", "number", ["number", "number"]), qc = n("RegisterExtensionFunctions", "number", ["number"]), ub = n("sqlite3_update_hook", "number", ["number", "number", "number"]);
          c.prototype.bind = function(f) {
            if (!this.Va) throw "Statement closed";
            this.reset();
            return Array.isArray(f) ? this.bc(f) : f != null && typeof f === "object" ? this.cc(f) : true;
          };
          c.prototype.step = function() {
            if (!this.Va) throw "Statement closed";
            this.Ta = 1;
            var f = wc(this.Va);
            switch (f) {
              case 100:
                return true;
              case 101:
                return false;
              default:
                throw this.db.handleError(f);
            }
          };
          c.prototype.Ub = function(f) {
            f == null && (f = this.Ta, this.Ta += 1);
            return zc(this.Va, f);
          };
          c.prototype.oc = function(f) {
            f == null && (f = this.Ta, this.Ta += 1);
            if (typeof BigInt !== "function") throw Error("BigInt is not supported");
            return BigInt(this.Vb(f));
          };
          c.prototype.Vb = function(f) {
            f == null && (f = this.Ta, this.Ta += 1);
            var h = Ac(this.Va, f);
            f = rb(this.Va, f);
            return A(h, f, true);
          };
          c.prototype.getBlob = function(f) {
            f == null && (f = this.Ta, this.Ta += 1);
            var h = rb(this.Va, f);
            f = Bc(this.Va, f);
            for (var p = new Uint8Array(h), r = 0; r < h; r += 1) p[r] = v[f + r];
            return p;
          };
          c.prototype.get = function(f, h) {
            h = h || {};
            f != null && this.bind(f) && this.step();
            f = [];
            for (var p = yc(this.Va), r = 0; r < p; r += 1) switch (Cc(this.Va, r)) {
              case 1:
                var u = h.useBigInt ? this.oc(r) : this.Ub(r);
                f.push(u);
                break;
              case 2:
                f.push(this.Ub(r));
                break;
              case 3:
                f.push(this.Vb(r));
                break;
              case 4:
                f.push(this.getBlob(r));
                break;
              default:
                f.push(null);
            }
            return f;
          };
          c.prototype.Ib = function() {
            for (var f = [], h = xc(this.Va), p = 0; p < h; p += 1) f.push(Dc(this.Va, p));
            return f;
          };
          c.prototype.Tb = function(f, h) {
            var p = this.get(f, h);
            f = this.Ib();
            return Object.fromEntries(f.map(function(r, u) {
              return [r, p[u]];
            }));
          };
          c.prototype.tc = function() {
            return N(this.Va);
          };
          c.prototype.qc = function() {
            return rc(this.Va);
          };
          c.prototype.run = function(f) {
            f != null && this.bind(f);
            this.step();
            return this.reset();
          };
          c.prototype.Pb = function(f, h) {
            h == null && (h = this.Ta, this.Ta += 1);
            var p = ea(f);
            this.Eb.push(p);
            this.db.handleError(sc(this.Va, h, p, l(f), 0));
          };
          c.prototype.ac = function(f, h) {
            h == null && (h = this.Ta, this.Ta += 1);
            var p = ca(f.length);
            v.set(f, p);
            this.Eb.push(p);
            this.db.handleError(qb(
              this.Va,
              h,
              p,
              f.length,
              0
            ));
          };
          c.prototype.Ob = function(f, h) {
            h == null && (h = this.Ta, this.Ta += 1);
            this.db.handleError((f === (f | 0) ? uc : tc)(this.Va, h, f));
          };
          c.prototype.dc = function(f) {
            f == null && (f = this.Ta, this.Ta += 1);
            qb(this.Va, f, 0, 0, 0);
          };
          c.prototype.Qb = function(f, h) {
            h == null && (h = this.Ta, this.Ta += 1);
            switch (typeof f) {
              case "string":
                this.Pb(f, h);
                return;
              case "number":
                this.Ob(f, h);
                return;
              case "bigint":
                this.Pb(f.toString(), h);
                return;
              case "boolean":
                this.Ob(f + 0, h);
                return;
              case "object":
                if (f === null) {
                  this.dc(h);
                  return;
                }
                if (f.length != null) {
                  this.ac(
                    f,
                    h
                  );
                  return;
                }
            }
            throw "Wrong API use : tried to bind a value of an unknown type (" + f + ").";
          };
          c.prototype.cc = function(f) {
            var h = this;
            Object.keys(f).forEach(function(p) {
              var r = vc(h.Va, p);
              r !== 0 && h.Qb(f[p], r);
            });
            return true;
          };
          c.prototype.bc = function(f) {
            for (var h = 0; h < f.length; h += 1) this.Qb(f[h], h + 1);
            return true;
          };
          c.prototype.reset = function() {
            this.Hb();
            return Fc(this.Va) === 0 && Ec(this.Va) === 0;
          };
          c.prototype.Hb = function() {
            for (var f; (f = this.Eb.pop()) !== void 0; ) da(f);
          };
          c.prototype.jb = function() {
            this.Hb();
            var f = Gc(this.Va) === 0;
            delete this.db.Bb[this.Va];
            this.Va = 0;
            return f;
          };
          e.prototype.next = function() {
            if (this.tb === null) return { done: true };
            this.fb !== null && (this.fb.jb(), this.fb = null);
            if (!this.db.db) throw this.ub(), Error("Database closed");
            var f = la(), h = ka(4);
            oa(q);
            oa(h);
            try {
              this.db.handleError(Pa(this.db.db, this.zb, -1, q, h));
              this.zb = y(h, "i32");
              var p = y(q, "i32");
              if (p === 0) return this.ub(), { done: true };
              this.fb = new c(p, this.db);
              this.db.Bb[p] = this.fb;
              return { value: this.fb, done: false };
            } catch (r) {
              throw this.Kb = A(this.zb), this.ub(), r;
            } finally {
              pa(f);
            }
          };
          e.prototype.ub = function() {
            da(this.tb);
            this.tb = null;
          };
          e.prototype["return"] = function() {
            this.fb !== null && (this.fb.jb(), this.fb = null);
            this.ub();
            return { done: true };
          };
          e.prototype.rc = function() {
            return this.Kb !== null ? this.Kb : A(this.zb);
          };
          typeof Symbol === "function" && typeof Symbol.iterator === "symbol" && (e.prototype[Symbol.iterator] = function() {
            return this;
          });
          g.prototype.run = function(f, h) {
            if (!this.db) throw "Database closed";
            if (h) {
              f = this.Lb(f, h);
              try {
                f.step();
              } finally {
                f.jb();
              }
            } else {
              f = ea(f);
              try {
                this.handleError(ha(this.db, f, 0, 0, q));
              } finally {
                da(f);
              }
            }
            return this;
          };
          g.prototype.exec = function(f, h, p) {
            if (!this.db) throw "Database closed";
            var r = la(), u = null, w = null, x = null;
            try {
              x = w = ea(f);
              var G = ka(4);
              for (f = []; y(x, "i8") !== 0; ) {
                oa(q);
                oa(G);
                this.handleError(Pa(this.db, x, -1, q, G));
                var T = y(q, "i32");
                x = y(G, "i32");
                if (T !== 0) {
                  var D = null;
                  u = new c(T, this);
                  for (h != null && u.bind(h); u.step(); ) D === null && (D = { columns: u.Ib(), values: [] }, f.push(D)), D.values.push(u.get(null, p));
                  u.jb();
                }
              }
              return f;
            } catch (K) {
              throw u && u.jb(), K;
            } finally {
              w && da(w), pa(r);
            }
          };
          g.prototype.lc = function(f, h, p, r, u) {
            typeof h === "function" && (r = p, p = h, h = void 0);
            f = this.Lb(f, h);
            try {
              for (; f.step(); ) p(f.Tb(null, u));
            } finally {
              f.jb();
            }
            if (typeof r === "function") return r();
          };
          g.prototype.Lb = function(f, h) {
            f = ea(f);
            try {
              oa(q), this.handleError(Pa(this.db, f, -1, q, 0));
            } finally {
              da(f);
            }
            f = y(q, "i32");
            if (f === 0) throw "Nothing to prepare";
            var p = new c(f, this);
            h != null && p.bind(h);
            return this.Bb[f] = p;
          };
          g.prototype.wc = function(f) {
            return new e(f, this);
          };
          g.prototype.nc = function() {
            if (!this.db) throw Error("Database closed");
            var f = this.filename + "_export";
            fa(f, []);
            var h = 0, p = 0;
            try {
              var r = B(f).node, u = null, w = r.Qa.write;
              r.Qa = Object.create(r.Qa);
              r.Qa.write = function(T, D, K, V, U) {
                if (u === null) return w(T, D, K, V, U);
                r.Ua.set(D.subarray(K, K + V), U);
                r.Wa = Math.max(r.Wa, U + V);
                return V;
              };
              var x = F(f, q);
              h = y(q, "i32");
              if (x !== 0) throw Error(ia(h));
              p = Oa(h, "main", this.db, "main");
              if (p === 0) throw Error(ia(h));
              x = ma(p, 0);
              if (x === 0) {
                var G = this.exec("PRAGMA main.page_count; PRAGMA main.page_size");
                u = new Uint8Array(G[0].values[0][0] * G[1].values[0][0]);
                r.Ua = u;
                x = ma(p, -1);
              }
              if (x === 5 || x === 6) throw Error("Unable to export: SQLite is busy or locked. Finish active write transactions before exporting.");
              if (x !== 101) throw Error(ia(h));
              x = na(p);
              p = 0;
              if (x !== 0) throw Error(ia(h));
              x = S(h);
              if (x !== 0) throw Error(ia(h));
              h = 0;
              u = new Uint8Array(r.Ua.buffer, r.Ua.byteOffset, r.Wa);
              u.length > 0 && (u[18] = 1, u[19] = 1);
              return u;
            } finally {
              p !== 0 && na(p), h !== 0 && S(h), qa("/" + f);
            }
          };
          g.prototype.close = function() {
            this.db !== null && (Object.values(this.Bb).forEach(function(f) {
              f.jb();
            }), this.ab.forEach(t), this.ab.clear(), this.lb && (ja(this.lb), this.lb = void 0), this.handleError(S(this.db)), qa("/" + this.filename), this.db = null);
          };
          g.prototype.handleError = function(f) {
            if (f === 0) return null;
            f = ia(this.db);
            throw Error(f);
          };
          g.prototype.sc = function() {
            return za(this.db);
          };
          g.prototype.jc = function(f, h) {
            var p = m(f, h.length);
            this.ab.has(p) && (t(this.ab.get(p)), this.ab.delete(p));
            var r = ra(function(u, w, x) {
              w = d(w, x);
              try {
                var G = h.apply(null, w);
              } catch (T) {
                a(u, T);
                return;
              }
              b(u, G);
            }, "viii");
            this.ab.set(p, [r]);
            this.handleError(sb(this.db, f, h.length, 1, 0, r, 0, 0, 0));
            return this;
          };
          g.prototype.hc = function(f, h) {
            function p(D) {
              x.has(D) || x.set(D, r());
              return x.get(D);
            }
            var r = h.init || function() {
              return null;
            }, u = h.finalize || function(D) {
              return D;
            }, w = h.step;
            if (!w) throw "An aggregate function must have a step function in " + f;
            var x = /* @__PURE__ */ new Map();
            h = m(f, w.length - 1);
            this.ab.has(h) && (t(this.ab.get(h)), this.ab.delete(h));
            var G = ra(function(D, K, V) {
              var U = tb(D, 1), Ra = p(U);
              K = d(K, V);
              Ra = [Ra].concat(K);
              try {
                x.set(U, w.apply(null, Ra));
              } catch (Hc) {
                x.delete(U), a(D, Hc);
              }
            }, "viii"), T = ra(function(D) {
              var K = tb(D, 1);
              try {
                var V = u(p(K));
              } catch (U) {
                x.delete(K);
                a(D, U);
                return;
              }
              b(D, V);
              x.delete(K);
            }, "vi");
            this.ab.set(h, [G, T]);
            this.handleError(sb(
              this.db,
              f,
              w.length - 1,
              1,
              0,
              0,
              G,
              T,
              0
            ));
            return this;
          };
          g.prototype.Dc = function(f) {
            this.lb && (ub(this.db, 0, 0), ja(this.lb), this.lb = void 0);
            if (!f) return this;
            this.lb = ra(function(h, p, r, u, w) {
              switch (p) {
                case 18:
                  h = "insert";
                  break;
                case 23:
                  h = "update";
                  break;
                case 9:
                  h = "delete";
                  break;
                default:
                  throw "unknown operationCode in updateHook callback: " + p;
              }
              r = A(r);
              u = A(u);
              if (w > Number.MAX_SAFE_INTEGER) throw "rowId too big to fit inside a Number";
              f(h, r, u, Number(w));
            }, "viiiij");
            ub(this.db, this.lb, 0);
            return this;
          };
          c.prototype.bind = c.prototype.bind;
          c.prototype.step = c.prototype.step;
          c.prototype.get = c.prototype.get;
          c.prototype.getColumnNames = c.prototype.Ib;
          c.prototype.getAsObject = c.prototype.Tb;
          c.prototype.getSQL = c.prototype.tc;
          c.prototype.getNormalizedSQL = c.prototype.qc;
          c.prototype.run = c.prototype.run;
          c.prototype.reset = c.prototype.reset;
          c.prototype.freemem = c.prototype.Hb;
          c.prototype.free = c.prototype.jb;
          e.prototype.next = e.prototype.next;
          e.prototype.getRemainingSQL = e.prototype.rc;
          g.prototype.run = g.prototype.run;
          g.prototype.exec = g.prototype.exec;
          g.prototype.each = g.prototype.lc;
          g.prototype.prepare = g.prototype.Lb;
          g.prototype.iterateStatements = g.prototype.wc;
          g.prototype["export"] = g.prototype.nc;
          g.prototype.close = g.prototype.close;
          g.prototype.handleError = g.prototype.handleError;
          g.prototype.getRowsModified = g.prototype.sc;
          g.prototype.create_function = g.prototype.jc;
          g.prototype.create_aggregate = g.prototype.hc;
          g.prototype.updateHook = g.prototype.Dc;
          k.Database = g;
        };
        var sa = "./this.program", ta = globalThis.document?.currentScript?.src;
        ba && (ta = self.location.href);
        var ua = "", va, wa;
        if (aa || ba) {
          try {
            ua = new URL(".", ta).href;
          } catch {
          }
          ba && (wa = (a) => {
            var b = new XMLHttpRequest();
            b.open("GET", a, false);
            b.responseType = "arraybuffer";
            b.send(null);
            return new Uint8Array(b.response);
          });
          va = async (a) => {
            a = await fetch(a, { credentials: "same-origin" });
            if (a.ok) return a.arrayBuffer();
            throw Error(a.status + " : " + a.url);
          };
        }
        var xa = console.log.bind(console), C = console.error.bind(console), ya, Aa = false, Ba;
        function Ca() {
          if (!v?.buffer?.resizable) {
            var a = Da.buffer;
            v = new Int8Array(a);
            Ea = new Int16Array(a);
            E = new Uint8Array(a);
            H = new Int32Array(a);
            I = new Uint32Array(a);
            Fa = new Float32Array(a);
            Ga = new Float64Array(a);
            J = new BigInt64Array(a);
          }
        }
        function Ha() {
          var a = k.preRun;
          a && (typeof a === "function" && (a = [a]), Ia.push(...a));
          for (a = Ia; a.length > 0; ) a.shift()(k);
        }
        function Ja() {
          var a = k.postRun;
          a && (typeof a === "function" && (a = [a]), Ka.push(...a));
          for (a = Ka; a.length > 0; ) a.shift()(k);
        }
        function La(a) {
          k.onAbort?.(a);
          a = `Aborted(${a})`;
          C(a);
          Aa = true;
          throw new WebAssembly.RuntimeError(a + ". Build with -sASSERTIONS for more info.");
        }
        var Ma;
        async function Na(a) {
          if (!ya) try {
            return await va(a);
          } catch {
          }
          if (a == Ma && ya) a = new Uint8Array(ya);
          else if (wa) a = wa(a);
          else throw "both async and sync fetching of the wasm failed";
          return a;
        }
        async function Qa(a, b) {
          try {
            var d = await Na(a);
            return await WebAssembly.instantiate(d, b);
          } catch (c) {
            C(`failed to asynchronously prepare wasm: ${c}`), La(c);
          }
        }
        async function Sa(a) {
          var b = Ma;
          if (!ya) try {
            var d = fetch(b, { credentials: "same-origin" });
            return await WebAssembly.instantiateStreaming(d, a);
          } catch (c) {
            C(`wasm streaming compile failed: ${c}`), C("falling back to ArrayBuffer instantiation");
          }
          return Qa(b, a);
        }
        class Ta {
          name = "ExitStatus";
          constructor(a) {
            this.message = `Program terminated with exit(${a})`;
            this.status = a;
          }
        }
        var v, Ka = [], Ia = [], Ua = true, E, Va = new TextDecoder(), Wa = (a, b, d, c) => {
          d = b + d;
          if (c) return d;
          for (; a[b] && !(b >= d); ) ++b;
          return b;
        }, A = (a, b, d) => a ? Va.decode(E.subarray(a, Wa(E, a, b, d))) : "", Xa = (a, b) => {
          for (var d = 0, c = a.length - 1; c >= 0; c--) {
            var e = a[c];
            e === "." ? a.splice(c, 1) : e === ".." ? (a.splice(c, 1), d++) : d && (a.splice(c, 1), d--);
          }
          if (b) for (; d; d--) a.unshift("..");
          return a;
        }, Ya = (a) => {
          var b = a.charAt(0) === "/", d = a.slice(-1) === "/";
          (a = Xa(a.split("/").filter((c) => !!c), !b).join("/")) || b || (a = ".");
          a && d && (a += "/");
          return (b ? "/" : "") + a;
        }, Za = (a) => {
          var b = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/.exec(a).slice(1);
          a = b[0];
          b = b[1];
          if (!a && !b) return ".";
          b &&= b.slice(0, -1);
          return a + b;
        }, $a = (a) => a && a.match(/([^\/]+|\/)\/*$/)[1], ab = (...a) => {
          for (var b = "", d = false, c = a.length - 1; c >= -1 && !d; c--) {
            d = c >= 0 ? a[c] : "/";
            if (typeof d !== "string") throw new TypeError("Arguments to path.resolve must be strings");
            if (!d) return "";
            b = d + "/" + b;
            d = d.charAt(0) === "/";
          }
          b = Xa(b.split("/").filter((e) => !!e), !d).join("/");
          return (d ? "/" : "") + b || ".";
        }, l = (a) => {
          for (var b = 0, d = 0; d < a.length; ++d) {
            var c = a.codePointAt(d);
            c <= 127 ? b++ : c <= 2047 ? b += 2 : c <= 65535 ? b += 3 : (b += 4, d++);
          }
          return b;
        }, L = (a, b, d, c) => {
          if (!(c > 0)) return 0;
          var e = d;
          c = d + c - 1;
          for (var g = 0; g < a.length; ++g) {
            var m = a.codePointAt(g);
            if (m <= 127) {
              if (d >= c) break;
              b[d++] = m;
            } else if (m <= 2047) {
              if (d + 1 >= c) break;
              b[d++] = 192 | m >> 6;
              b[d++] = 128 | m & 63;
            } else if (m <= 65535) {
              if (d + 2 >= c) break;
              b[d++] = 224 | m >> 12;
              b[d++] = 128 | m >> 6 & 63;
              b[d++] = 128 | m & 63;
            } else {
              if (d + 3 >= c) break;
              b[d++] = 240 | m >> 18;
              b[d++] = 128 | m >> 12 & 63;
              b[d++] = 128 | m >> 6 & 63;
              b[d++] = 128 | m & 63;
              g++;
            }
          }
          b[d] = 0;
          return d - e;
        }, bb = (a) => {
          var b = Array(l(a) + 1);
          a = L(a, b, 0, b.length);
          b.length = a;
          return b;
        }, cb = (a, b) => {
          var d = 0;
          a && (d |= 365);
          b && (d |= 146);
          return d;
        }, M = { cb: null, hb() {
          return M.createNode(null, "/", 16895, 0);
        }, createNode(a, b, d, c) {
          if ((d & 61440) === 24576 || (d & 61440) === 4096) throw new O(63);
          M.cb || (M.cb = { dir: { node: { $a: M.Ra.$a, eb: M.Ra.eb, rb: M.Ra.rb, wb: M.Ra.wb, Zb: M.Ra.Zb, Db: M.Ra.Db, Ab: M.Ra.Ab, Nb: M.Ra.Nb, Cb: M.Ra.Cb }, stream: { bb: M.Qa.bb } }, file: { node: { $a: M.Ra.$a, eb: M.Ra.eb }, stream: { bb: M.Qa.bb, read: M.Qa.read, write: M.Qa.write, xb: M.Qa.xb, yb: M.Qa.yb } }, link: { node: { $a: M.Ra.$a, eb: M.Ra.eb, kb: M.Ra.kb }, stream: {} }, Rb: { node: { $a: M.Ra.$a, eb: M.Ra.eb }, stream: db } });
          d = eb(a, b, d, c);
          P(d.mode) ? (d.Ra = M.cb.dir.node, d.Qa = M.cb.dir.stream, d.Ua = {}) : (d.mode & 61440) === 32768 ? (d.Ra = M.cb.file.node, d.Qa = M.cb.file.stream, d.Wa = 0, d.Ua = M.mc ?? (M.mc = new Uint8Array(0))) : (d.mode & 61440) === 40960 ? (d.Ra = M.cb.link.node, d.Qa = M.cb.link.stream) : (d.mode & 61440) === 8192 && (d.Ra = M.cb.Rb.node, d.Qa = M.cb.Rb.stream);
          d.gb = d.Ya = d.Xa = Date.now();
          a && (a.Ua[b] = d, a.gb = a.Ya = a.Xa = d.gb);
          return d;
        }, Ra: { $a(a) {
          var b = {};
          b.kc = (a.mode & 61440) === 8192 ? a.id : 1;
          b.vc = a.id;
          b.mode = a.mode;
          b.yc = 1;
          b.uid = 0;
          b.uc = 0;
          b.sb = a.sb;
          P(a.mode) ? b.size = 4096 : (a.mode & 61440) === 32768 ? b.size = a.Wa : (a.mode & 61440) === 40960 ? b.size = a.link.length : b.size = 0;
          b.gb = new Date(a.gb);
          b.Ya = new Date(a.Ya);
          b.Xa = new Date(a.Xa);
          b.ec = 4096;
          b.fc = Math.ceil(b.size / b.ec);
          return b;
        }, eb(a, b) {
          for (var d of ["mode", "atime", "mtime", "ctime"]) b[d] != null && (a[d] = b[d]);
          b.size !== void 0 && (b = b.size, a.Wa != b && (d = a.Ua, a.Ua = new Uint8Array(b), a.Ua.set(d.subarray(0, Math.min(b, a.Wa))), a.Wa = b));
        }, rb() {
          M.Fb || (M.Fb = new O(44), M.Fb.stack = "<generic error, no stack>");
          throw M.Fb;
        }, wb(a, b, d, c) {
          return M.createNode(
            a,
            b,
            d,
            c
          );
        }, Zb(a, b, d) {
          try {
            var c = fb(b, d);
          } catch (g) {
          }
          if (c && P(a.mode)) for (var e in c.Ua) throw new O(55);
          delete a.parent.Ua[a.name];
          b.Ua[d] = a;
          a.name = d;
          b.Xa = b.Ya = a.parent.Xa = a.parent.Ya = Date.now();
        }, Db(a, b) {
          delete a.Ua[b];
          a.Xa = a.Ya = Date.now();
        }, Ab(a, b) {
          var d = fb(a, b), c;
          for (c in d.Ua) throw new O(55);
          delete a.Ua[b];
          a.Xa = a.Ya = Date.now();
        }, Nb(a) {
          return [".", "..", ...Object.keys(a.Ua)];
        }, Cb(a, b, d) {
          a = M.createNode(a, b, 41471, 0);
          a.link = d;
          return a;
        }, kb(a) {
          if ((a.mode & 61440) !== 40960) throw new O(28);
          return a.link;
        } }, Qa: { read(a, b, d, c, e) {
          if (e >= a.node.Wa) return 0;
          c = Math.min(a.node.Wa - e, c);
          b.set(a.node.Ua.subarray(e, e + c), d);
          return c;
        }, write(a, b, d, c, e, g) {
          b.buffer === v.buffer && (g = false);
          if (!c) return 0;
          a = a.node;
          a.Ya = a.Xa = Date.now();
          if (g) a.Ua = b.subarray(d, d + c), a.Wa = c;
          else if (a.Wa || e) {
            g = e + c;
            var m = a.Ua.length;
            m >= g || (g = Math.max(g, m * (m < 1048576 ? 2 : 1.125) >>> 0), m && (g = Math.max(g, 256)), m = a.Ua.subarray(0, a.Wa), a.Ua = new Uint8Array(g), a.Ua.set(m));
            a.Ua.set(b.subarray(d, d + c), e);
            a.Wa = Math.max(a.Wa, e + c);
          } else a.Ua = b.slice(d, d + c), a.Wa = c;
          return c;
        }, bb(a, b, d) {
          d === 1 ? b += a.position : d === 2 && (a.node.mode & 61440) === 32768 && (b += a.node.Wa);
          if (b < 0) throw new O(28);
          return b;
        }, xb(a, b, d, c, e) {
          if ((a.node.mode & 61440) !== 32768) throw new O(43);
          a = a.node.Ua;
          if (e & 2 || a.buffer !== v.buffer) {
            e = true;
            c = Math.ceil(b / 65536) * 65536;
            var g = gb(65536, c);
            g && E.fill(0, g, g + c);
            c = g;
            if (!c) throw new O(48);
            if (a) {
              if (d > 0 || d + b < a.length) a = a.subarray ? a.subarray(d, d + b) : a.slice(d, d + b);
              v.set(a, c);
            }
          } else e = false, c = a.byteOffset;
          return { Bc: c, $b: e };
        }, yb(a, b, d, c) {
          M.Qa.write(a, b, 0, c, d, false);
          return 0;
        } } }, hb = [], ib = (a) => {
          var b = Wa(a, 0);
          return Va.decode(a.buffer ? a.subarray(0, b) : new Uint8Array(a.slice(0, b)));
        }, jb = [];
        function kb(a, b) {
          jb[a] = { input: [], output: [], pb: b };
          lb(a, pb);
        }
        var pb = { open(a) {
          var b = jb[a.node.sb];
          if (!b) throw new O(43);
          a.Za = b;
          a.seekable = false;
        }, close(a) {
          a.Za.pb.qb(a.Za);
        }, qb(a) {
          a.Za.pb.qb(a.Za);
        }, read(a, b, d, c) {
          if (!a.Za || !a.Za.pb.Wb) throw new O(60);
          for (var e = 0, g = 0; g < c; g++) {
            try {
              var m = a.Za.pb.Wb(a.Za);
            } catch (t) {
              throw new O(29);
            }
            if (m === void 0 && !e) throw new O(6);
            if (m === null || m === void 0) break;
            e++;
            b[d + g] = m;
            if (m === 10) break;
          }
          e && (a.node.gb = Date.now());
          return e;
        }, write(a, b, d, c) {
          if (!a.Za || !a.Za.pb.Mb) throw new O(60);
          try {
            for (var e = 0; e < c; e++) a.Za.pb.Mb(a.Za, b[d + e]);
          } catch (g) {
            throw new O(29);
          }
          c && (a.node.Ya = a.node.Xa = Date.now());
          return e;
        } }, vb = { Wb() {
          a: {
            if (!hb.length) {
              var a = null;
              globalThis.window?.prompt && (a = window.prompt("Input: "), a !== null && (a += "\n"));
              if (!a) {
                a = null;
                break a;
              }
              hb = bb(a);
            }
            a = hb.shift();
          }
          return a;
        }, Mb(a, b) {
          b === null || b === 10 ? (xa(ib(a.output)), a.output = []) : b != 0 && a.output.push(b);
        }, qb(a) {
          a.output?.length > 0 && (xa(ib(a.output)), a.output = []);
        }, Kc() {
          return { Gc: 25856, Ic: 5, Fc: 191, Hc: 35387, Ec: [3, 28, 127, 21, 4, 0, 1, 0, 17, 19, 26, 0, 18, 15, 23, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };
        }, Lc() {
          return 0;
        }, Mc() {
          return [
            24,
            80
          ];
        } }, wb = { Mb(a, b) {
          b === null || b === 10 ? (C(ib(a.output)), a.output = []) : b != 0 && a.output.push(b);
        }, qb(a) {
          a.output?.length > 0 && (C(ib(a.output)), a.output = []);
        } }, xb = () => (a) => (crypto.getRandomValues(a), 0), yb = (a) => (yb = xb())(a), zb = null, Ab = {}, Bb = [], Cb = 1, Q = [], Db = false, Eb = true, Fb = {}, O = class {
          name = "ErrnoError";
          constructor(a) {
            this.Sa = a;
          }
        }, Gb = class {
          shared = {};
          node = null;
          get flags() {
            return this.shared.flags;
          }
          set flags(a) {
            this.shared.flags = a;
          }
          get position() {
            return this.shared.position;
          }
          set position(a) {
            this.shared.position = a;
          }
        }, Hb = class {
          Ra = {};
          Qa = {};
          nb = null;
          constructor(a, b, d, c) {
            a ||= this;
            this.parent = a;
            this.hb = a.hb;
            this.id = Cb++;
            this.name = b;
            this.mode = d;
            this.sb = c;
            this.gb = this.Ya = this.Xa = Date.now();
          }
          get read() {
            return (this.mode & 365) === 365;
          }
          set read(a) {
            a ? this.mode |= 365 : this.mode &= -366;
          }
          get write() {
            return (this.mode & 146) === 146;
          }
          set write(a) {
            a ? this.mode |= 146 : this.mode &= -147;
          }
          Ac() {
          }
        };
        function B(a, b = {}) {
          if (!a) throw new O(44);
          b.Gb ?? (b.Gb = true);
          a.charAt(0) === "/" || (a = "//" + a);
          var d = 0;
          a: for (; d < 40; d++) {
            a = a.split("/").filter((t) => !!t);
            for (var c = zb, e = "/", g = 0; g < a.length; g++) {
              var m = g === a.length - 1;
              if (m && b.parent) break;
              if (a[g] !== ".") if (a[g] === "..") if (e = Za(e), c === c.parent) {
                a = e + "/" + a.slice(g + 1).join("/");
                d--;
                continue a;
              } else c = c.parent;
              else {
                e = Ya(e + "/" + a[g]);
                try {
                  c = fb(c, a[g]);
                } catch (t) {
                  if (t?.Sa === 44 && m && b.zc) return { path: e };
                  throw t;
                }
                !c.nb || m && !b.Gb || (c = c.nb.root);
                if ((c.mode & 61440) === 40960 && (!m || b.mb)) {
                  if (!c.Ra.kb) throw new O(52);
                  c = c.Ra.kb(c);
                  c.charAt(0) === "/" || (c = Za(e) + "/" + c);
                  a = c + "/" + a.slice(g + 1).join("/");
                  continue a;
                }
              }
            }
            return { path: e, node: c };
          }
          throw new O(32);
        }
        function Ib(a) {
          for (var b; ; ) {
            if (a === a.parent) return a = a.hb.Yb, b ? a[a.length - 1] !== "/" ? `${a}/${b}` : a + b : a;
            b = b ? `${a.name}/${b}` : a.name;
            a = a.parent;
          }
        }
        function Jb(a, b) {
          for (var d = 0, c = 0; c < b.length; c++) d = (d << 5) - d + b.charCodeAt(c) | 0;
          return (a + d >>> 0) % Q.length;
        }
        function Kb(a) {
          var b = Jb(a.parent.id, a.name);
          if (Q[b] === a) Q[b] = a.ob;
          else for (b = Q[b]; b; ) {
            if (b.ob === a) {
              b.ob = a.ob;
              break;
            }
            b = b.ob;
          }
        }
        function fb(a, b) {
          var d = P(a.mode) ? (d = Lb(a, "x")) ? d : a.Ra.rb ? 0 : 2 : 54;
          if (d) throw new O(d);
          for (d = Q[Jb(a.id, b)]; d; d = d.ob) {
            var c = d.name;
            if (d.parent.id === a.id && c === b) return d;
          }
          return a.Ra.rb(a, b);
        }
        function eb(a, b, d, c) {
          a = new Hb(a, b, d, c);
          b = Jb(a.parent.id, a.name);
          a.ob = Q[b];
          return Q[b] = a;
        }
        function P(a) {
          return (a & 61440) === 16384;
        }
        function Lb(a, b) {
          return Eb ? 0 : b.includes("r") && !(a.mode & 292) || b.includes("w") && !(a.mode & 146) || b.includes("x") && !(a.mode & 73) ? 2 : 0;
        }
        function Mb(a, b) {
          if (!P(a.mode)) return 54;
          try {
            return fb(a, b), 20;
          } catch (d) {
          }
          return Lb(a, "wx");
        }
        function Nb(a, b, d) {
          try {
            var c = fb(a, b);
          } catch (e) {
            return e.Sa;
          }
          if (a = Lb(a, "wx")) return a;
          if (d) {
            if (!P(c.mode)) return 54;
            if (c === c.parent || Ib(c) === "/") return 10;
          } else if (P(c.mode)) return 31;
          return 0;
        }
        function Ob(a) {
          if (!a) throw new O(63);
          return a;
        }
        function R(a) {
          a = Bb[a];
          if (!a) throw new O(8);
          return a;
        }
        function Pb(a, b = -1) {
          a = Object.assign(new Gb(), a);
          if (b == -1) a: {
            for (b = 0; b <= 4096; b++) if (!Bb[b]) break a;
            throw new O(33);
          }
          a.ib = b;
          return Bb[b] = a;
        }
        function Qb(a, b = -1) {
          a = Pb(a, b);
          a.Qa?.Jc?.(a);
          return a;
        }
        function Rb(a, b, d) {
          var c = a?.Qa.eb;
          a = c ? a : b;
          c ??= b.Ra.eb;
          Ob(c);
          try {
            c(a, d);
          } catch (e) {
            if (e instanceof RangeError) throw new O(22);
            throw e;
          }
        }
        var db = { open(a) {
          a.Qa = Ab[a.node.sb].Qa;
          a.Qa.open?.(a);
        }, bb() {
          throw new O(70);
        } };
        function lb(a, b) {
          Ab[a] = { Qa: b };
        }
        function Sb(a, b) {
          var d = b === "/";
          if (d && zb) throw new O(10);
          if (!d && b) {
            var c = B(b, { Gb: false });
            b = c.path;
            c = c.node;
            if (c.nb) throw new O(10);
            if (!P(c.mode)) throw new O(54);
          }
          b = { type: a, Nc: {}, Yb: b, xc: [] };
          a = a.hb(b);
          a.hb = b;
          b.root = a;
          d ? zb = a : c && (c.nb = b, c.hb && c.hb.xc.push(b));
        }
        function Tb(a, b, d) {
          var c = B(a, { parent: true }).node;
          a = $a(a);
          if (!a) throw new O(28);
          if (a === "." || a === "..") throw new O(20);
          var e = Mb(c, a);
          if (e) throw new O(e);
          if (!c.Ra.wb) throw new O(63);
          return c.Ra.wb(c, a, b, d);
        }
        function Ub(a, b = 438) {
          return Tb(a, b & 4095 | 32768, 0);
        }
        function W(a, b = 511) {
          return Tb(a, b & 1023 | 16384, 0);
        }
        function Vb(a, b, d) {
          typeof d === "undefined" && (d = b, b = 438);
          Tb(a, b | 8192, d);
        }
        function Wb(a, b) {
          if (!ab(a)) throw new O(44);
          var d = B(b, { parent: true }).node;
          if (!d) throw new O(44);
          b = $a(b);
          var c = Mb(d, b);
          if (c) throw new O(c);
          if (!d.Ra.Cb) throw new O(63);
          d.Ra.Cb(d, b, a);
        }
        function Xb(a) {
          var b = B(a, { parent: true }).node;
          a = $a(a);
          var d = fb(b, a), c = Nb(b, a, true);
          if (c) throw new O(c);
          if (!b.Ra.Ab) throw new O(63);
          if (d.nb) throw new O(10);
          b.Ra.Ab(b, a);
          Kb(d);
        }
        function qa(a) {
          var b = B(a, { parent: true }).node;
          if (!b) throw new O(44);
          a = $a(a);
          var d = fb(b, a), c = Nb(b, a, false);
          if (c) throw new O(c);
          if (!b.Ra.Db) throw new O(63);
          if (d.nb) throw new O(10);
          b.Ra.Db(b, a);
          Kb(d);
        }
        function Yb(a, b = false) {
          a = B(a, { mb: !b }).node;
          return Ob(a.Ra.$a)(a);
        }
        function Zb(a, b, d) {
          Rb(a, b, { mode: d & 4095 | b.mode & -4096, Xa: Date.now(), Sb: false });
        }
        function $b(a, b) {
          a = typeof a === "string" ? B(a, { mb: true }).node : a;
          Zb(null, a, b);
        }
        function ac(a, b, d) {
          if (P(b.mode)) throw new O(31);
          if ((b.mode & 61440) !== 32768) throw new O(28);
          var c = Lb(b, "w");
          if (c) throw new O(c);
          Rb(a, b, { size: d, timestamp: Date.now() });
        }
        function bc(a, b, d, c = false) {
          a = B(a, { mb: !c });
          Rb(null, a.node, { gb: b, Ya: d, Sb: c });
        }
        function cc(a, b, d = 438) {
          if (a === "") throw new O(44);
          if (typeof b === "string") {
            var c = { r: 0, "r+": 2, w: 577, "w+": 578, a: 1089, "a+": 1090 }[b];
            if (typeof c === "undefined") throw Error(`Unknown file open mode: ${b}`);
            b = c;
          }
          d = b & 64 ? d & 4095 | 32768 : 0;
          if (typeof a === "object") c = a;
          else {
            var e = a.endsWith("/");
            a = B(a, { mb: !(b & 131072), zc: true });
            c = a.node;
            a = a.path;
          }
          var g = false;
          if (b & 64) if (c) {
            if (b & 128) throw new O(20);
          } else {
            if (e) throw new O(31);
            c = Tb(a, d | 511, 0);
            g = true;
          }
          if (!c) throw new O(44);
          (c.mode & 61440) === 8192 && (b &= -513);
          if (b & 65536 && !P(c.mode)) throw new O(54);
          if (!g && (c ? (c.mode & 61440) === 40960 ? e = 32 : (e = ["r", "w", "rw"][b & 3], b & 512 && (e += "w"), e = P(c.mode) && (e !== "r" || b & 576) ? 31 : Lb(c, e)) : e = 44, e)) throw new O(e);
          b & 512 && !g && (e = c, e = typeof e === "string" ? B(e, { mb: true }).node : e, ac(null, e, 0));
          b &= -131713;
          e = Pb({ node: c, path: Ib(c), flags: b, seekable: true, position: 0, Qa: c.Qa, Cc: [], error: false });
          e.Qa.open && e.Qa.open(e);
          g && $b(c, d & 511);
          !k.logReadFiles || b & 1 || a in Fb || (Fb[a] = 1, C(`read file: ${a}`));
          return e;
        }
        function dc(a) {
          if (a.ib === null) throw new O(8);
          a.Jb && (a.Jb = null);
          a.node?.Ac();
          try {
            a.Qa.close && a.Qa.close(a);
          } catch (b) {
            throw b;
          } finally {
            Bb[a.ib] = null;
          }
          a.ib = null;
        }
        function ec(a, b, d) {
          if (a.ib === null) throw new O(8);
          if (!a.seekable || !a.Qa.bb) throw new O(70);
          if (d != 0 && d != 1 && d != 2) throw new O(28);
          a.position = a.Qa.bb(a, b, d);
          a.Cc = [];
        }
        function fc(a, b, d, c, e) {
          if (c < 0 || e < 0) throw new O(28);
          if (a.ib === null) throw new O(8);
          if ((a.flags & 2097155) === 0) throw new O(8);
          if (P(a.node.mode)) throw new O(31);
          if (!a.Qa.write) throw new O(28);
          a.seekable && a.flags & 1024 && ec(a, 0, 2);
          var g = typeof e !== "undefined";
          if (!g) e = a.position;
          else if (!a.seekable) throw new O(70);
          b = a.Qa.write(a, b, d, c, e, void 0);
          g || (a.position += b);
          return b;
        }
        function hc() {
          var a, b, d;
          Db = true;
          a ??= k.stdin;
          b ??= k.stdout;
          d ??= k.stderr;
          a ? X("stdin", a) : Wb("/dev/tty", "/dev/stdin");
          b ? X("stdout", null, b) : Wb("/dev/tty", "/dev/stdout");
          d ? X("stderr", null, d) : Wb("/dev/tty1", "/dev/stderr");
          cc("/dev/stdin", 0);
          cc("/dev/stdout", 1);
          cc("/dev/stderr", 1);
        }
        function fa(a, b) {
          var d = "/", c = a;
          d && (d = typeof d === "string" ? d : Ib(d), c = a ? Ya(d + "/" + a) : d);
          a = cb(true, true);
          c = Ub(c, a);
          b && (typeof b === "string" && (b = bb(b)), b.subarray || (b = new Uint8Array(b)), $b(c, a | 146), d = cc(c, 577), fc(d, b, 0, b.length, 0), dc(d), $b(c, a));
        }
        function X(a, b, d) {
          a = Ya("/dev/" + a);
          var c = cb(!!b, !!d);
          X.Xb ?? (X.Xb = 64);
          var e = X.Xb++ << 8 | 0;
          lb(e, { open(g) {
            g.seekable = false;
          }, close() {
            d?.buffer?.length && d(10);
          }, read(g, m, t, z) {
            for (var q = 0, n = 0; n < z; n++) {
              try {
                var F = b();
              } catch (S) {
                throw new O(29);
              }
              if (F === void 0 && !q) throw new O(6);
              if (F === null || F === void 0) break;
              q++;
              m[t + n] = F;
            }
            q && (g.node.gb = Date.now());
            return q;
          }, write(g, m, t, z) {
            for (var q = 0; q < z; q++) try {
              d(m[t + q]);
            } catch (n) {
              throw new O(29);
            }
            z && (g.node.Ya = g.node.Xa = Date.now());
            return q;
          } });
          Vb(a, c, e);
        }
        var Y = {}, H, J, I;
        function Ic(a, b, d = false) {
          if (b.charAt(0) === "/") return b;
          a = a === -100 ? "/" : R(a).path;
          if (b.length == 0) {
            if (!d) throw new O(44);
            return a;
          }
          return a + "/" + b;
        }
        function Jc(a, b) {
          I[a >> 2] = b.kc;
          I[a + 4 >> 2] = b.mode;
          I[a + 8 >> 2] = b.yc;
          I[a + 12 >> 2] = b.uid;
          I[a + 16 >> 2] = b.uc;
          I[a + 20 >> 2] = b.sb;
          J[a + 24 >> 3] = BigInt(b.size);
          H[a + 32 >> 2] = 4096;
          H[a + 36 >> 2] = b.fc;
          var d = b.gb.getTime(), c = b.Ya.getTime(), e = b.Xa.getTime();
          J[a + 40 >> 3] = BigInt(Math.floor(d / 1e3));
          I[a + 48 >> 2] = d % 1e3 * 1e3 * 1e3;
          J[a + 56 >> 3] = BigInt(Math.floor(c / 1e3));
          I[a + 64 >> 2] = c % 1e3 * 1e3 * 1e3;
          J[a + 72 >> 3] = BigInt(Math.floor(e / 1e3));
          I[a + 80 >> 2] = e % 1e3 * 1e3 * 1e3;
          J[a + 88 >> 3] = BigInt(b.vc);
          return 0;
        }
        var Kc = void 0, Ea, Lc = () => {
          var a = H[+Kc >> 2];
          Kc += 4;
          return a;
        }, Mc = 0, Nc = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335], Oc = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334], Pc = (a) => {
          if (!(a instanceof Ta || a == "unwind")) throw a;
        }, Qc = (a) => {
          Ba = a;
          Ua || Mc > 0 || (k.onExit?.(a), Aa = true);
          throw new Ta(a);
        }, Rc = {}, Sc = {}, Uc = () => {
          if (!Tc) {
            var a = { USER: "web_user", LOGNAME: "web_user", PATH: "/", PWD: "/", HOME: "/home/web_user", LANG: (globalThis.navigator?.language ?? "C").replace("-", "_") + ".UTF-8", _: sa }, b;
            for (b in Sc) Sc[b] === void 0 ? delete a[b] : a[b] = Sc[b];
            var d = [];
            for (b in a) d.push(`${b}=${a[b]}`);
            Tc = d;
          }
          return Tc;
        }, Tc, Fa, Ga;
        function oa(a) {
          var b = "i32";
          b.endsWith("*") && (b = "*");
          switch (b) {
            case "i1":
              v[a] = 0;
              break;
            case "i8":
              v[a] = 0;
              break;
            case "i16":
              Ea[a >> 1] = 0;
              break;
            case "i32":
              H[a >> 2] = 0;
              break;
            case "i64":
              J[a >> 3] = BigInt(0);
              break;
            case "float":
              Fa[a >> 2] = 0;
              break;
            case "double":
              Ga[a >> 3] = 0;
              break;
            case "*":
              I[a >> 2] = 0;
              break;
            default:
              La(`invalid type for setValue: ${b}`);
          }
        }
        function y(a, b = "i8") {
          b.endsWith("*") && (b = "*");
          switch (b) {
            case "i1":
              return v[a];
            case "i8":
              return v[a];
            case "i16":
              return Ea[a >> 1];
            case "i32":
              return H[a >> 2];
            case "i64":
              return J[a >> 3];
            case "float":
              return Fa[a >> 2];
            case "double":
              return Ga[a >> 3];
            case "*":
              return I[a >> 2];
            default:
              La(`invalid type for getValue: ${b}`);
          }
        }
        var Vc = (a, b, d, c) => {
          var e = { string: (q) => {
            var n = 0;
            if (q !== null && q !== void 0 && q !== 0) {
              n = l(q) + 1;
              var F = ka(n);
              L(q, E, F, n);
              n = F;
            }
            return n;
          }, array: (q) => {
            var n = ka(q.length);
            v.set(q, n);
            return n;
          } };
          a = k["_" + a];
          var g = [], m = 0;
          if (c) for (var t = 0; t < c.length; t++) {
            var z = e[d[t]];
            z ? (m ||= la(), g[t] = z(c[t])) : g[t] = c[t];
          }
          d = a(...g);
          return d = (function(q) {
            m && pa(m);
            return b === "string" ? A(q) : b === "boolean" ? !!q : q;
          })(d);
        }, ea = (a) => {
          var b = l(a) + 1, d = ca(b);
          d && L(a, E, d, b);
          return d;
        }, Wc = [], Xc, ja = (a) => {
          Xc.delete(Z.get(a));
          Z.set(a, null);
          Wc.push(a);
        }, Yc = (a) => {
          var b = a.length;
          return [b % 128 | 128, b >> 7, ...a];
        }, Zc = { i: 127, p: 127, j: 126, f: 125, d: 124, e: 111 }, $c = (a) => Yc(Array.from(a, (b) => Zc[b])), ra = (a, b) => {
          if (!Xc) {
            Xc = /* @__PURE__ */ new WeakMap();
            var d = Z.length;
            if (Xc) for (var c = 0; c < 0 + d; c++) {
              var e = Z.get(c);
              e && Xc.set(e, c);
            }
          }
          if (d = Xc.get(a) || 0) return d;
          d = Wc.length ? Wc.pop() : Z.grow(1);
          try {
            Z.set(d, a);
          } catch (g) {
            if (!(g instanceof TypeError)) throw g;
            b = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, ...Yc([1, 96, ...$c(b.slice(1)), ...$c(b[0] === "v" ? "" : b[0])]), 2, 7, 1, 1, 101, 1, 102, 0, 0, 7, 5, 1, 1, 102, 0, 0);
            b = new WebAssembly.Module(b);
            b = new WebAssembly.Instance(
              b,
              { e: { f: a } }
            ).exports.f;
            Z.set(d, b);
          }
          Xc.set(a, d);
          return d;
        };
        Q.length = 4096;
        Sb(M, "/");
        W("/tmp");
        W("/home");
        W("/home/web_user");
        (function() {
          W("/dev");
          lb(259, { read: () => 0, write: (c, e, g, m) => m, bb: () => 0 });
          Vb("/dev/null", 259);
          kb(1280, vb);
          kb(1536, wb);
          Vb("/dev/tty", 1280);
          Vb("/dev/tty1", 1536);
          var a = new Uint8Array(1024), b = 0, d = () => {
            b || (yb(a), b = a.byteLength);
            return a[--b];
          };
          X("random", d);
          X("urandom", d);
          W("/dev/shm");
          W("/dev/shm/tmp");
        })();
        (function() {
          W("/proc");
          var a = W("/proc/self");
          W("/proc/self/fd");
          Sb({ hb() {
            var b = eb(a, "fd", 16895, 73);
            b.Qa = { bb: M.Qa.bb };
            b.Ra = { rb(d, c) {
              d = +c;
              var e = R(d);
              d = { parent: null, hb: { Yb: "fake" }, Ra: { kb: () => e.path }, id: d + 1 };
              return d.parent = d;
            }, Nb() {
              return Array.from(Bb.entries()).filter(([, d]) => d).map(([d]) => d.toString());
            } };
            return b;
          } }, "/proc/self/fd");
        })();
        k.noExitRuntime && (Ua = k.noExitRuntime);
        k.print && (xa = k.print);
        k.printErr && (C = k.printErr);
        k.wasmBinary && (ya = k.wasmBinary);
        k.thisProgram && (sa = k.thisProgram);
        var ad = k.preInit;
        if (ad) for (typeof ad === "function" && (k.preInit = ad = [ad]); ad.length > 0; ) ad.shift()();
        k.stackSave = () => la();
        k.stackRestore = (a) => pa(a);
        k.stackAlloc = (a) => ka(a);
        k.cwrap = (a, b, d, c) => {
          var e = !d || d.every((g) => g === "number" || g === "boolean");
          return b !== "string" && e && !c ? k["_" + a] : (...g) => Vc(a, b, d, g);
        };
        k.addFunction = ra;
        k.removeFunction = ja;
        k.UTF8ToString = A;
        k.lengthBytesUTF8 = l;
        k.stringToNewUTF8 = ea;
        k.writeArrayToMemory = (a, b) => {
          v.set(a, b);
        };
        var ca, da, gb, bd, pa, ka, la, Da, Z, cd = {
          a: (a, b, d, c) => La(`Assertion failed: ${A(a)}, at: ` + [b ? A(b) : "unknown filename", d, c ? A(c) : "unknown function"]),
          i: function(a, b) {
            try {
              return a = A(a), $b(a, b), 0;
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return -d.Sa;
            }
          },
          D: function(a, b, d) {
            try {
              b = A(b);
              b = Ic(a, b);
              if (d & -8) return -28;
              var c = B(b, { mb: true }).node;
              if (!c) return -44;
              a = "";
              d & 4 && (a += "r");
              d & 2 && (a += "w");
              d & 1 && (a += "x");
              return a && Lb(c, a) ? -2 : 0;
            } catch (e) {
              if (typeof Y === "undefined" || e.name !== "ErrnoError") throw e;
              return -e.Sa;
            }
          },
          j: function(a, b) {
            try {
              var d = R(a);
              Zb(d, d.node, b);
              return 0;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return -c.Sa;
            }
          },
          h: function(a) {
            try {
              var b = R(a);
              Rb(b, b.node, { timestamp: Date.now(), Sb: false });
              return 0;
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return -d.Sa;
            }
          },
          b: function(a, b, d) {
            Kc = d;
            try {
              var c = R(a);
              switch (b) {
                case 0:
                  var e = Lc();
                  if (e < 0) break;
                  for (; Bb[e]; ) e++;
                  return Qb(c, e).ib;
                case 1:
                case 2:
                  return 0;
                case 3:
                  return c.flags;
                case 4:
                  return e = Lc(), c.flags = c.flags & -289793 | e & 289792, 0;
                case 12:
                  return e = Lc(), Ea[e + 0 >> 1] = 2, 0;
                case 13:
                case 14:
                  return 0;
              }
              return -28;
            } catch (g) {
              if (typeof Y === "undefined" || g.name !== "ErrnoError") throw g;
              return -g.Sa;
            }
          },
          g: function(a, b) {
            try {
              var d = R(a), c = d.node, e = d.Qa.$a;
              a = e ? d : c;
              e ??= c.Ra.$a;
              Ob(e);
              var g = e(a);
              return Jc(b, g);
            } catch (m) {
              if (typeof Y === "undefined" || m.name !== "ErrnoError") throw m;
              return -m.Sa;
            }
          },
          J: function(a, b) {
            b = b < -9007199254740992 || b > 9007199254740992 ? NaN : Number(b);
            try {
              if (isNaN(b)) return -22;
              var d = R(a);
              if (b < 0 || (d.flags & 2097155) === 0) throw new O(28);
              ac(
                d,
                d.node,
                b
              );
              return 0;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return -c.Sa;
            }
          },
          I: function(a, b) {
            try {
              if (!b) return -28;
              var d = l("/") + 1;
              if (b < d) return -68;
              L("/", E, a, b);
              return d;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return -c.Sa;
            }
          },
          F: () => 0,
          M: function(a, b) {
            try {
              return a = A(a), Jc(b, Yb(a, true));
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return -d.Sa;
            }
          },
          C: function(a, b, d) {
            try {
              return b = A(b), b = Ic(a, b), W(b, d & -19), 0;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return -c.Sa;
            }
          },
          L: function(a, b, d, c) {
            try {
              b = A(b);
              var e = c & 256;
              b = Ic(a, b, c & 4096);
              return Jc(d, e ? Yb(b, true) : Yb(b));
            } catch (g) {
              if (typeof Y === "undefined" || g.name !== "ErrnoError") throw g;
              return -g.Sa;
            }
          },
          x: function(a, b, d, c) {
            Kc = c;
            try {
              b = A(b);
              b = Ic(a, b);
              var e = c ? Lc() : 0;
              d & 64 && (e &= -19);
              return cc(b, d, e).ib;
            } catch (g) {
              if (typeof Y === "undefined" || g.name !== "ErrnoError") throw g;
              return -g.Sa;
            }
          },
          s: function(a, b, d, c) {
            try {
              b = A(b);
              b = Ic(a, b);
              if (c <= 0) return -28;
              var e = B(b).node;
              if (!e) throw new O(44);
              if (!e.Ra.kb) throw new O(28);
              var g = e.Ra.kb(e);
              var m = Math.min(c, l(g)), t = v[d + m];
              L(g, E, d, c + 1);
              v[d + m] = t;
              return m;
            } catch (z) {
              if (typeof Y === "undefined" || z.name !== "ErrnoError") throw z;
              return -z.Sa;
            }
          },
          r: function(a) {
            try {
              return a = A(a), Xb(a), 0;
            } catch (b) {
              if (typeof Y === "undefined" || b.name !== "ErrnoError") throw b;
              return -b.Sa;
            }
          },
          N: function(a, b) {
            try {
              return a = A(a), Jc(b, Yb(a));
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return -d.Sa;
            }
          },
          o: function(a, b, d) {
            try {
              b = A(b);
              b = Ic(a, b);
              if (d) if (d === 512) Xb(b);
              else return -28;
              else qa(b);
              return 0;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return -c.Sa;
            }
          },
          n: function(a, b, d, c) {
            try {
              c &= 256;
              b = A(b);
              b = Ic(a, b, true);
              var e = Date.now();
              if (d) {
                let t2 = function(z) {
                  var q = H[z + 8 >> 2];
                  return q == 1073741823 ? e : q == 1073741822 ? null : (I[z >> 2] + H[z + 4 >> 2] * 4294967296) * 1e3 + Math.floor(q / 1e6);
                };
                var t = t2;
                var g = t2(d);
                var m = t2(d + 16);
              } else m = g = e;
              (m ?? g) !== null && bc(b, g, m, c);
              return 0;
            } catch (t2) {
              if (typeof Y === "undefined" || t2.name !== "ErrnoError") throw t2;
              return -t2.Sa;
            }
          },
          w: () => La(""),
          v: () => {
            Ua = false;
            Mc = 0;
          },
          A: function(a, b) {
            a = a < -9007199254740992 || a > 9007199254740992 ? NaN : Number(a);
            a = new Date(a * 1e3);
            if (isNaN(a.getTime())) return 1;
            H[b >> 2] = a.getSeconds();
            H[b + 4 >> 2] = a.getMinutes();
            H[b + 8 >> 2] = a.getHours();
            H[b + 12 >> 2] = a.getDate();
            H[b + 16 >> 2] = a.getMonth();
            H[b + 20 >> 2] = a.getFullYear() - 1900;
            H[b + 24 >> 2] = a.getDay();
            var d = a.getFullYear();
            H[b + 28 >> 2] = (d % 4 !== 0 || d % 100 === 0 && d % 400 !== 0 ? Oc : Nc)[a.getMonth()] + a.getDate() - 1 | 0;
            H[b + 36 >> 2] = -(a.getTimezoneOffset() * 60);
            d = new Date(a.getFullYear(), 6, 1).getTimezoneOffset();
            var c = new Date(a.getFullYear(), 0, 1).getTimezoneOffset();
            H[b + 32 >> 2] = (d != c && a.getTimezoneOffset() == Math.min(c, d)) | 0;
            return 0;
          },
          y: function(a, b, d, c, e, g, m) {
            e = e < -9007199254740992 || e > 9007199254740992 ? NaN : Number(e);
            try {
              var t = R(c);
              if (b & 2 && !(d & 2) && (t.flags & 2097155) !== 2) throw new O(2);
              if ((t.flags & 2097155) === 1) throw new O(2);
              if (!t.Qa.xb) throw new O(43);
              if (!a) throw new O(28);
              var z = t.Qa.xb(t, a, e, b, d);
              var q = z.Bc;
              H[g >> 2] = z.$b;
              I[m >> 2] = q;
              return 0;
            } catch (n) {
              if (typeof Y === "undefined" || n.name !== "ErrnoError") throw n;
              return -n.Sa;
            }
          },
          z: function(a, b, d, c, e, g) {
            g = g < -9007199254740992 || g > 9007199254740992 ? NaN : Number(g);
            try {
              var m = R(e);
              if (d & 2) {
                if ((m.node.mode & 61440) !== 32768) throw new O(43);
                c & 2 || m.Qa.yb && m.Qa.yb(m, E.subarray(a, a + b), g, b, c);
              }
            } catch (t) {
              if (typeof Y === "undefined" || t.name !== "ErrnoError") throw t;
              return -t.Sa;
            }
          },
          k: (a, b) => {
            Rc[a] && (clearTimeout(Rc[a].id), delete Rc[a]);
            if (!b) return 0;
            var d = setTimeout(() => {
              delete Rc[a];
              var c = [a, performance.now()], e = bd;
              if (!Aa) try {
                e(...c);
              } catch (g) {
                Pc(g);
              } finally {
                if (!(Ua || Mc > 0)) try {
                  Ba = c = Ba, Qc(c);
                } catch (g) {
                  Pc(g);
                }
              }
            }, b);
            Rc[a] = { id: d, Oc: b };
            return 0;
          },
          B: (a, b, d, c) => {
            var e = (/* @__PURE__ */ new Date()).getFullYear(), g = new Date(e, 0, 1).getTimezoneOffset();
            e = new Date(e, 6, 1).getTimezoneOffset();
            I[a >> 2] = Math.max(g, e) * 60;
            H[b >> 2] = Number(g != e);
            b = (m) => {
              var t = Math.abs(m);
              return `UTC${m >= 0 ? "-" : "+"}${String(Math.floor(t / 60)).padStart(2, "0")}${String(t % 60).padStart(2, "0")}`;
            };
            a = b(g);
            b = b(e);
            e < g ? (L(a, E, d, 17), L(b, E, c, 17)) : (L(a, E, c, 17), L(b, E, d, 17));
          },
          d: () => Date.now(),
          p: () => 2147483648,
          c: () => performance.now(),
          l: (a) => {
            var b = E.length;
            a >>>= 0;
            if (a > 2147483648) return false;
            for (var d = 1; d <= 4; d *= 2) {
              var c = b * (1 + 0.2 / d);
              c = Math.min(c, a + 100663296);
              a: {
                c = (Math.min(2147483648, Math.ceil(Math.max(a, c) / 65536) * 65536) - Da.buffer.byteLength + 65535) / 65536 | 0;
                try {
                  Da.grow(c);
                  Ca();
                  var e = 1;
                  break a;
                } catch (g) {
                }
                e = void 0;
              }
              if (e) return true;
            }
            return false;
          },
          G: (a, b) => {
            var d = 0, c = 0, e;
            for (e of Uc()) {
              var g = b + d;
              I[a + c >> 2] = g;
              d += L(e, E, g, Infinity) + 1;
              c += 4;
            }
            return 0;
          },
          H: (a, b) => {
            var d = Uc();
            I[a >> 2] = d.length;
            a = 0;
            for (var c of d) a += l(c) + 1;
            I[b >> 2] = a;
            return 0;
          },
          e: function(a) {
            try {
              var b = R(a);
              dc(b);
              return 0;
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return d.Sa;
            }
          },
          m: function(a, b) {
            try {
              var d = R(a);
              v[b] = d.Za ? 2 : P(d.mode) ? 3 : (d.mode & 61440) === 40960 ? 7 : 4;
              Ea[b + 2 >> 1] = 0;
              J[b + 8 >> 3] = BigInt(0);
              J[b + 16 >> 3] = BigInt(0);
              return 0;
            } catch (c) {
              if (typeof Y === "undefined" || c.name !== "ErrnoError") throw c;
              return c.Sa;
            }
          },
          t: function(a, b, d, c) {
            try {
              a: {
                var e = R(a);
                a = b;
                for (var g, m = b = 0; m < d; m++) {
                  var t = I[a >> 2], z = I[a + 4 >> 2];
                  a += 8;
                  try {
                    var q = e, n = t, F = z, S = g, Oa = v;
                    if (F < 0 || S < 0) throw new O(28);
                    if (q.ib === null) throw new O(8);
                    if ((q.flags & 2097155) === 1) throw new O(8);
                    if (P(q.node.mode)) throw new O(31);
                    if (!q.Qa.read) throw new O(28);
                    var ma = typeof S !== "undefined";
                    if (!ma) S = q.position;
                    else if (!q.seekable) throw new O(70);
                    var na = q.Qa.read(q, Oa, n, F, S);
                    ma || (q.position += na);
                    var ha = na;
                  } catch (N) {
                    if (b > 0 && N instanceof O && (N.Sa == 6 || N.Sa == 6)) break;
                    throw N;
                  }
                  if (ha < 0) {
                    var za = -1;
                    break a;
                  }
                  b += ha;
                  if (ha < z) break;
                  typeof g !== "undefined" && (g += ha);
                }
                za = b;
              }
              I[c >> 2] = za;
              return 0;
            } catch (N) {
              if (typeof Y === "undefined" || N.name !== "ErrnoError") throw N;
              return N.Sa;
            }
          },
          E: function(a, b, d, c) {
            b = b < -9007199254740992 || b > 9007199254740992 ? NaN : Number(b);
            try {
              if (isNaN(b)) return 22;
              var e = R(a);
              ec(e, b, d);
              J[c >> 3] = BigInt(e.position);
              e.Jb && !b && d === 0 && (e.Jb = null);
              return 0;
            } catch (g) {
              if (typeof Y === "undefined" || g.name !== "ErrnoError") throw g;
              return g.Sa;
            }
          },
          K: function(a) {
            try {
              var b = R(a);
              return b.Qa?.qb?.(b);
            } catch (d) {
              if (typeof Y === "undefined" || d.name !== "ErrnoError") throw d;
              return d.Sa;
            }
          },
          q: function(a, b, d, c) {
            try {
              var e = R(a);
              a = b;
              if (d == 1) var g = fc(e, v, I[a >> 2], I[a + 4 >> 2]);
              else {
                for (var m = b = 0, t = a; m < d; m++, t += 8) b += I[t + 4 >> 2];
                var z = new Uint8Array(b);
                for (m = t = 0; m < d; m++, a += 8) {
                  var q = I[a >> 2], n = I[a + 4 >> 2];
                  z.set(
                    E.subarray(q, q + n),
                    t
                  );
                  t += n;
                }
                g = fc(e, z, 0, b);
              }
              I[c >> 2] = g;
              return 0;
            } catch (F) {
              if (typeof Y === "undefined" || F.name !== "ErrnoError") throw F;
              return F.Sa;
            }
          },
          u: Qc,
          f: function(a) {
            console.warn("sql.js: legacy function " + A(a) + "() is deprecated and will be disabled by default in the next major version. Initialize with useOldExtensionFunctions: false to use native SQLite functions. See https://github.com/sql-js/sql.js/pull/647");
          }
        };
        async function dd() {
          Ha();
          var a = k.setStatus;
          a && (a("Running..."), await new Promise((b) => setTimeout(b, 1)), setTimeout(a, 1, ""));
          Aa || (k.noFSInit || Db || hc(), ed.P(), Eb = false, k.onRuntimeInitialized?.(), Ja());
        }
        var ed;
        (async function() {
          function a(c) {
            c = ed = c.exports;
            k._sqlite3_free = c.R;
            k._sqlite3_value_text = c.S;
            k._sqlite3_prepare_v2 = c.T;
            k._sqlite3_step = c.U;
            k._sqlite3_reset = c.V;
            k._sqlite3_exec = c.W;
            k._sqlite3_finalize = c.X;
            k._sqlite3_column_name = c.Y;
            k._sqlite3_column_text = c.Z;
            k._sqlite3_column_type = c._;
            k._sqlite3_errmsg = c.$;
            k._sqlite3_backup_init = c.aa;
            k._sqlite3_backup_step = c.ba;
            k._sqlite3_backup_finish = c.ca;
            k._sqlite3_clear_bindings = c.da;
            k._sqlite3_value_blob = c.ea;
            k._sqlite3_value_bytes = c.fa;
            k._sqlite3_value_double = c.ga;
            k._sqlite3_value_int = c.ha;
            k._sqlite3_value_type = c.ia;
            k._sqlite3_result_blob = c.ja;
            k._sqlite3_result_double = c.ka;
            k._sqlite3_result_error = c.la;
            k._sqlite3_result_int = c.ma;
            k._sqlite3_result_int64 = c.na;
            k._sqlite3_result_null = c.oa;
            k._sqlite3_result_text = c.pa;
            k._sqlite3_aggregate_context = c.qa;
            k._sqlite3_column_count = c.ra;
            k._sqlite3_data_count = c.sa;
            k._sqlite3_column_blob = c.ta;
            k._sqlite3_column_bytes = c.ua;
            k._sqlite3_column_double = c.va;
            k._sqlite3_bind_blob = c.wa;
            k._sqlite3_bind_double = c.xa;
            k._sqlite3_bind_int = c.ya;
            k._sqlite3_bind_text = c.za;
            k._sqlite3_bind_parameter_index = c.Aa;
            k._sqlite3_sql = c.Ba;
            k._sqlite3_normalized_sql = c.Ca;
            k._sqlite3_changes = c.Da;
            k._sqlite3_close_v2 = c.Ea;
            k._sqlite3_create_function_v2 = c.Fa;
            k._sqlite3_update_hook = c.Ga;
            k._sqlite3_open = c.Ha;
            ca = k._malloc = c.Ia;
            da = k._free = c.Ja;
            k._RegisterExtensionFunctions = c.Ka;
            gb = c.La;
            bd = c.Ma;
            pa = c.Na;
            ka = c.Oa;
            la = c.Pa;
            Da = c.O;
            Z = c.Q;
            Ca();
            return ed;
          }
          var b = { a: cd }, d = k.instantiateWasm;
          if (d) return new Promise((c) => {
            d(b, (e) => c(a(e)));
          });
          Ma ??= k.locateFile ? k.locateFile(
            "sql-wasm-browser.wasm",
            ua
          ) : ua + "sql-wasm-browser.wasm";
          return (function(c) {
            return a(c.instance);
          })(await Sa(b));
        })().then(() => dd());
        return Module;
      });
      return initSqlJsPromise;
    };
    if (typeof exports === "object" && typeof module === "object") {
      module.exports = initSqlJs2;
      module.exports.default = initSqlJs2;
    } else if (typeof define === "function" && define["amd"]) {
      define([], function() {
        return initSqlJs2;
      });
    } else if (typeof exports === "object") {
      exports["Module"] = initSqlJs2;
    }
  }
});

// security-worker/diary-restore.mjs
var import_sql = __toESM(require_sql_wasm_browser(), 1);

// trusted:ddl
var ddl_default = "CREATE TABLE IF NOT EXISTS diary_entries (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  entry_date TEXT NOT NULL,\n  title TEXT NOT NULL,\n  content TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  deleted_at TEXT,\n  revision INTEGER NOT NULL DEFAULT 1\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_entries_active_date\nON diary_entries(deleted_at, entry_date DESC, id DESC);\n\nCREATE TABLE IF NOT EXISTS diary_tags (\n  entry_id INTEGER NOT NULL,\n  tag TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (entry_id, tag),\n  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_tags_tag\nON diary_tags(tag);\n\nALTER TABLE diary_entries\nADD COLUMN author_id TEXT NOT NULL DEFAULT 'unknown';\n\nALTER TABLE diary_entries\nADD COLUMN author_name TEXT NOT NULL DEFAULT '\u4E0D\u660E';\n\nCREATE TABLE IF NOT EXISTS investment_history (\n  recorded_at TEXT PRIMARY KEY,\n  total INTEGER NOT NULL CHECK (total >= 0),\n  cash INTEGER NOT NULL DEFAULT 0 CHECK (cash >= 0),\n  stocks INTEGER NOT NULL DEFAULT 0 CHECK (stocks >= 0),\n  funds INTEGER NOT NULL DEFAULT 0 CHECK (funds >= 0),\n  bonds INTEGER NOT NULL DEFAULT 0 CHECK (bonds >= 0),\n  crypto INTEGER NOT NULL DEFAULT 0 CHECK (crypto >= 0),\n  futures INTEGER NOT NULL DEFAULT 0 CHECK (futures >= 0),\n  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),\n  other INTEGER NOT NULL DEFAULT 0 CHECK (other >= 0),\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nALTER TABLE diary_entries\nADD COLUMN deleted_by_id TEXT;\n\nALTER TABLE diary_entries\nADD COLUMN deleted_by_name TEXT;\n\nCREATE TABLE IF NOT EXISTS diary_photos (\n  id TEXT PRIMARY KEY,\n  entry_id INTEGER NOT NULL,\n  file_name TEXT NOT NULL,\n  content_type TEXT NOT NULL,\n  original_size INTEGER NOT NULL,\n  original_key TEXT NOT NULL UNIQUE,\n  display_key TEXT NOT NULL UNIQUE,\n  thumbnail_key TEXT NOT NULL UNIQUE,\n  width INTEGER,\n  height INTEGER,\n  created_by_id TEXT NOT NULL,\n  created_by_name TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_photos_entry\nON diary_photos(entry_id, created_at ASC, id ASC);\n\nCREATE INDEX IF NOT EXISTS idx_diary_photos_created\nON diary_photos(created_at DESC, id DESC);\n\nCREATE TABLE IF NOT EXISTS diary_login_attempts (\n  fingerprint TEXT PRIMARY KEY,\n  failed_count INTEGER NOT NULL DEFAULT 0,\n  first_failed_at INTEGER NOT NULL,\n  locked_until INTEGER\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_login_attempts_locked_until\nON diary_login_attempts(locked_until);\n\nCREATE TABLE IF NOT EXISTS diary_accounts (\n  id TEXT PRIMARY KEY,\n  household_id TEXT NOT NULL,\n  display_name TEXT NOT NULL,\n  login_id TEXT NOT NULL UNIQUE,\n  password_hash TEXT,\n  role TEXT NOT NULL DEFAULT 'admin',\n  must_change_password INTEGER NOT NULL DEFAULT 1,\n  can_view_trash INTEGER NOT NULL DEFAULT 1,\n  can_permanently_delete INTEGER NOT NULL DEFAULT 1,\n  can_view_investment INTEGER NOT NULL DEFAULT 0,\n  session_version INTEGER NOT NULL DEFAULT 1,\n  active INTEGER NOT NULL DEFAULT 1,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\n\nINSERT OR IGNORE INTO diary_accounts (\n  id, household_id, display_name, login_id, role,\n  must_change_password, can_view_trash, can_permanently_delete,\n  can_view_investment, session_version, active\n) VALUES (\n  'chiharu-admin', 'chiharu-household', '\u7530\u4E2D\u5343\u6674',\n  'flw2-0203freedom@ezweb.ne.jp', 'admin',\n  1, 1, 1, 0, 1, 1\n);\n\nALTER TABLE diary_entries\nADD COLUMN household_id TEXT NOT NULL DEFAULT 'tanaka-household';\n\nCREATE INDEX IF NOT EXISTS idx_diary_entries_household_date\nON diary_entries(household_id, deleted_at, entry_date DESC, id DESC);\n\nUPDATE diary_accounts\nSET login_id = 'giantz3031@gmail.com',\n    password_hash = NULL,\n    must_change_password = 1,\n    session_version = session_version + 1,\n    updated_at = CURRENT_TIMESTAMP\nWHERE id = 'chiharu-admin'\n  AND active = 1;\n\nINSERT INTO diary_accounts (\n  id, household_id, display_name, login_id, role,\n  must_change_password, can_view_trash, can_permanently_delete,\n  can_view_investment, session_version, active\n) VALUES (\n  'main-user', 'tanaka-household', '\u7530\u4E2D\u5B8F\u77E5',\n  'sub@a-tanaka.jp', 'admin',\n  1, 0, 0, 1, 1, 1\n);\n\nALTER TABLE diary_entries\nADD COLUMN content_format TEXT;\n\nCREATE TABLE IF NOT EXISTS diary_trash_scopes (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  entry_id INTEGER NOT NULL,\n  owner_account_id TEXT NOT NULL,\n  household_id TEXT NOT NULL,\n  scope_type TEXT NOT NULL CHECK (scope_type IN ('personal', 'admin-retention', 'household')),\n  entry_revision INTEGER NOT NULL,\n  deleted_by_id TEXT,\n  deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  UNIQUE (entry_id, owner_account_id, scope_type),\n  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_trash_scopes_owner\nON diary_trash_scopes(household_id, owner_account_id, scope_type, deleted_at DESC, entry_id DESC);\n\nCREATE INDEX IF NOT EXISTS idx_diary_trash_scopes_entry\nON diary_trash_scopes(entry_id, household_id);\n\nCREATE TABLE IF NOT EXISTS diary_media_deletion_queue (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  entry_id INTEGER NOT NULL,\n  object_key TEXT NOT NULL UNIQUE,\n  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  last_error TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_media_deletion_queue_entry\nON diary_media_deletion_queue(entry_id, id);\n\nCREATE TRIGGER IF NOT EXISTS diary_queue_photo_cleanup_before_entry_delete\nBEFORE DELETE ON diary_entries\nBEGIN\n  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)\n  SELECT OLD.id, original_key FROM diary_photos WHERE entry_id = OLD.id;\n  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)\n  SELECT OLD.id, display_key FROM diary_photos WHERE entry_id = OLD.id;\n  INSERT OR IGNORE INTO diary_media_deletion_queue (entry_id, object_key)\n  SELECT OLD.id, thumbnail_key FROM diary_photos WHERE entry_id = OLD.id;\nEND;\n\n-- Preserve every existing deleted entry in the Tanaka household for the Global Owner.\nINSERT OR IGNORE INTO diary_trash_scopes (\n  entry_id, owner_account_id, household_id, scope_type,\n  entry_revision, deleted_by_id, deleted_at\n)\nSELECT\n  id, 'main-admin', household_id, 'admin-retention',\n  revision, deleted_by_id, deleted_at\nFROM diary_entries\nWHERE household_id = 'tanaka-household' AND deleted_at IS NOT NULL;\n\n-- Give the wife account independent retention only when she authored and deleted the entry herself.\nINSERT OR IGNORE INTO diary_trash_scopes (\n  entry_id, owner_account_id, household_id, scope_type,\n  entry_revision, deleted_by_id, deleted_at\n)\nSELECT\n  id, 'wife-admin', household_id, 'personal',\n  revision, deleted_by_id, deleted_at\nFROM diary_entries\nWHERE household_id = 'tanaka-household'\n  AND author_id = 'wife-admin'\n  AND deleted_by_id = 'wife-admin'\n  AND deleted_at IS NOT NULL;\n\n-- Chiharu's household remains a single personal trash scope; no Global Owner copy is created.\nINSERT OR IGNORE INTO diary_trash_scopes (\n  entry_id, owner_account_id, household_id, scope_type,\n  entry_revision, deleted_by_id, deleted_at\n)\nSELECT\n  id, 'chiharu-admin', household_id, 'personal',\n  revision, deleted_by_id, deleted_at\nFROM diary_entries\nWHERE household_id = 'chiharu-household' AND deleted_at IS NOT NULL;\n\nALTER TABLE diary_entries\nADD COLUMN status TEXT NOT NULL DEFAULT 'published'\nCHECK (status IN ('published', 'draft'));\n\nALTER TABLE diary_entries\nADD COLUMN draft_of_entry_id INTEGER;\n\nALTER TABLE diary_entries\nADD COLUMN draft_of_revision INTEGER;\n\nALTER TABLE diary_entries\nADD COLUMN draft_excluded_photo_ids TEXT;\n\nCREATE INDEX IF NOT EXISTS idx_diary_entries_household_status_updated\nON diary_entries(household_id, status, deleted_at, updated_at DESC, id DESC);\n\nCREATE UNIQUE INDEX IF NOT EXISTS idx_diary_entries_single_edit_draft\nON diary_entries(household_id, draft_of_entry_id)\nWHERE status = 'draft' AND deleted_at IS NULL AND draft_of_entry_id IS NOT NULL;\n\nALTER TABLE diary_accounts\nADD COLUMN can_manage_entries INTEGER NOT NULL DEFAULT 0;\n\nUPDATE diary_accounts\nSET can_manage_entries = CASE WHEN role = 'admin' OR id = 'main-user' THEN 1 ELSE 0 END;\n\nUPDATE diary_accounts\nSET role = 'user',\n    can_manage_entries = 1,\n    can_view_trash = 1,\n    can_permanently_delete = 1,\n    session_version = session_version + 1,\n    updated_at = CURRENT_TIMESTAMP\nWHERE id = 'main-user';\n\n-- Preserve already-deleted entries in main-user's personal trash when both\n-- authorship and deletion actor belong to the same account.\nINSERT OR IGNORE INTO diary_trash_scopes (\n  entry_id, owner_account_id, household_id, scope_type,\n  entry_revision, deleted_by_id, deleted_at\n)\nSELECT\n  id, 'main-user', household_id, 'personal',\n  revision, deleted_by_id, deleted_at\nFROM diary_entries\nWHERE household_id = 'tanaka-household'\n  AND author_id = 'main-user'\n  AND deleted_by_id = 'main-user'\n  AND deleted_at IS NOT NULL;\n\nALTER TABLE diary_media_deletion_queue\nADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;\n\nALTER TABLE diary_media_deletion_queue\nADD COLUMN last_attempt_at TEXT;\n\nCREATE INDEX IF NOT EXISTS idx_diary_media_deletion_queue_attempt\nON diary_media_deletion_queue(last_attempt_at, id);\n\nCREATE TABLE IF NOT EXISTS diary_favorites (\n  account_id TEXT NOT NULL,\n  entry_id INTEGER NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (account_id, entry_id),\n  FOREIGN KEY (entry_id) REFERENCES diary_entries(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_favorites_account_created\nON diary_favorites(account_id, created_at DESC, entry_id DESC);\n\nCREATE INDEX IF NOT EXISTS idx_diary_favorites_entry\nON diary_favorites(entry_id, account_id);\n\nCREATE TABLE IF NOT EXISTS diary_photo_upload_sessions (\n  id TEXT PRIMARY KEY,\n  household_id TEXT NOT NULL,\n  account_id TEXT NOT NULL,\n  target_entry_id INTEGER,\n  committed_entry_id INTEGER,\n  committed_photo_ids TEXT,\n  status TEXT NOT NULL DEFAULT 'active'\n    CHECK (status IN ('active', 'committed', 'cancelled')),\n  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),\n  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),\n  expires_at TEXT NOT NULL,\n  FOREIGN KEY (target_entry_id) REFERENCES diary_entries(id) ON DELETE SET NULL,\n  FOREIGN KEY (committed_entry_id) REFERENCES diary_entries(id) ON DELETE SET NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_photo_upload_sessions_cleanup\nON diary_photo_upload_sessions(status, expires_at, id);\n\nCREATE TABLE IF NOT EXISTS diary_staged_photos (\n  id TEXT PRIMARY KEY,\n  upload_session_id TEXT NOT NULL,\n  household_id TEXT NOT NULL,\n  account_id TEXT NOT NULL,\n  file_name TEXT NOT NULL,\n  content_type TEXT NOT NULL,\n  original_size INTEGER NOT NULL,\n  original_key TEXT NOT NULL UNIQUE,\n  display_key TEXT NOT NULL UNIQUE,\n  thumbnail_key TEXT NOT NULL UNIQUE,\n  width INTEGER,\n  height INTEGER,\n  created_by_name TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),\n  FOREIGN KEY (upload_session_id) REFERENCES diary_photo_upload_sessions(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_diary_staged_photos_session\nON diary_staged_photos(upload_session_id, created_at, id);\n\nALTER TABLE diary_entries ADD COLUMN client_request_id TEXT;\nALTER TABLE diary_entries ADD COLUMN client_request_hash TEXT;\nALTER TABLE diary_entries ADD COLUMN last_mutation_id TEXT;\n\nCREATE UNIQUE INDEX IF NOT EXISTS uq_diary_entries_client_request\nON diary_entries(household_id, author_id, client_request_id)\nWHERE client_request_id IS NOT NULL;\n\nALTER TABLE diary_tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0);\n\nWITH ranked_tags AS (\n  SELECT\n    rowid AS tag_rowid,\n    ROW_NUMBER() OVER (\n      PARTITION BY entry_id\n      ORDER BY rowid\n    ) - 1 AS calculated_sort_order\n  FROM diary_tags\n)\nUPDATE diary_tags\nSET sort_order = (\n  SELECT calculated_sort_order\n  FROM ranked_tags\n  WHERE ranked_tags.tag_rowid = diary_tags.rowid\n);\n\nALTER TABLE diary_entries ADD COLUMN weather TEXT DEFAULT NULL\n  CHECK (weather IS NULL OR weather IN (\n    'sunny', 'cloudy', 'partly_cloudy', 'cloudy_rain',\n    'rain', 'heavy_rain', 'thunder', 'snow'\n  ));\n\n-- Schema only. No account is stopped by migration; explicit per-account\n-- changes require tools/password-auth.mjs after account/Passkey preflight.\n-- No FK: Diary also has static accounts whose credentials remain in Secrets.\nCREATE TABLE password_auth_policy (\n  service TEXT NOT NULL CHECK (service = 'diary'),\n  account_id TEXT NOT NULL,\n  password_auth_enabled INTEGER NOT NULL CHECK (password_auth_enabled IN (0, 1)),\n  password_session_epoch INTEGER NOT NULL CHECK (password_session_epoch >= 1),\n  changed_by TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (service, account_id)\n);\nCREATE TABLE password_auth_policy_audit (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  service TEXT NOT NULL,\n  account_id TEXT NOT NULL,\n  event_type TEXT NOT NULL,\n  password_session_epoch INTEGER NOT NULL,\n  changed_by TEXT NOT NULL,\n  reason TEXT NOT NULL,\n  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);\nCREATE TRIGGER password_auth_policy_insert_audit AFTER INSERT ON password_auth_policy BEGIN\n  INSERT INTO password_auth_policy_audit (service, account_id, event_type, password_session_epoch, changed_by, reason)\n  VALUES (NEW.service, NEW.account_id, CASE NEW.password_auth_enabled WHEN 1 THEN 'password_auth_enabled' ELSE 'password_auth_disabled' END,\n    NEW.password_session_epoch, NEW.changed_by, NEW.reason);\nEND;\nCREATE TRIGGER password_auth_policy_update_audit AFTER UPDATE ON password_auth_policy BEGIN\n  INSERT INTO password_auth_policy_audit (service, account_id, event_type, password_session_epoch, changed_by, reason)\n  VALUES (NEW.service, NEW.account_id, CASE NEW.password_auth_enabled WHEN 1 THEN 'password_auth_enabled' ELSE 'password_auth_disabled' END,\n    NEW.password_session_epoch, NEW.changed_by, NEW.reason);\nEND;\n\n-- Removing or rolling back a policy could resurrect pre-disable cookies.\nCREATE TRIGGER password_auth_policy_no_delete BEFORE DELETE ON password_auth_policy BEGIN\n  SELECT RAISE(ABORT, 'Password policy rows must be retained');\nEND;\nCREATE TRIGGER password_auth_policy_monotonic BEFORE UPDATE ON password_auth_policy\nWHEN NEW.service != OLD.service OR NEW.account_id != OLD.account_id OR NEW.password_session_epoch <= OLD.password_session_epoch BEGIN\n  SELECT RAISE(ABORT, 'Password policy identity is immutable and epoch must advance');\nEND;\n\nALTER TABLE diary_entries\nADD COLUMN entry_time TEXT DEFAULT NULL\n  CHECK (\n    entry_time IS NULL OR (\n      entry_time GLOB '[0-2][0-9]:[0-5][0-9]'\n      AND substr(entry_time, 1, 2) BETWEEN '00' AND '23'\n    )\n  );\n\nCREATE INDEX IF NOT EXISTS idx_diary_entries_household_datetime\nON diary_entries(household_id, status, deleted_at, entry_date DESC, entry_time DESC, id DESC);\n\nALTER TABLE diary_entries\nADD COLUMN last_published_at TEXT DEFAULT NULL;\n\n-- Historical publication timestamps are reconstructed conservatively. A\n-- deletion overwrites updated_at, so deleted entries fall back to created_at\n-- rather than presenting the deletion time as a publication.\nUPDATE diary_entries\nSET last_published_at = CASE\n  WHEN status <> 'published' THEN NULL\n  WHEN revision <= 1 OR updated_at = created_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at)\n  WHEN deleted_at IS NOT NULL AND updated_at = deleted_at THEN strftime('%Y-%m-%dT%H:%M:%fZ', created_at)\n  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)\nEND\nWHERE last_published_at IS NULL;\n\nCREATE INDEX IF NOT EXISTS idx_diary_entries_household_published_at\nON diary_entries(household_id, status, deleted_at, entry_date DESC, last_published_at DESC, id DESC);\n\n-- Nullable until the independent photo job has verified source and backup.\n-- Existing source keys and photo bytes are unchanged. Snapshot payloads with\n-- NULL cannot claim photo identity merely from a later receipt.\nALTER TABLE diary_photos ADD COLUMN backup_identity TEXT DEFAULT NULL\n  CHECK (backup_identity IS NULL OR json_valid(backup_identity));\n\n-- Candidate schema for an ISOLATED database; deliberately outside migrations/.\n-- No dates, titles, tags, text, names, MIME types or original filenames.\nCREATE TABLE diary_e2ee_control (\n id INTEGER PRIMARY KEY CHECK(id=1),\n phase TEXT NOT NULL CHECK(phase IN ('legacy','migrating','encrypted','paused','restoring','rekeying','purging')),\n generation INTEGER NOT NULL CHECK(generation>=0),\n ever_encrypted INTEGER NOT NULL CHECK(ever_encrypted IN (0,1)),\n evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence))\n);\nINSERT INTO diary_e2ee_control VALUES(1,'legacy',0,0,NULL);\nCREATE TABLE diary_e2ee_records (\n id TEXT PRIMARY KEY, household TEXT NOT NULL, scope TEXT NOT NULL,\n state TEXT NOT NULL CHECK(state IN ('published','draft','trash','preferences','investment')),\n author TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), epoch INTEGER NOT NULL CHECK(epoch>0),\n source_id TEXT, source_revision INTEGER,\n retained_for TEXT NOT NULL CHECK(json_valid(retained_for)),\n envelope TEXT NOT NULL CHECK(json_valid(envelope)), summary TEXT NOT NULL CHECK(json_valid(summary)),\n photo_ids TEXT NOT NULL CHECK(json_valid(photo_ids)), request_id TEXT NOT NULL, mutation_id TEXT NOT NULL,\n key_box TEXT NOT NULL CHECK(json_valid(key_box)), attestation TEXT NOT NULL CHECK(json_valid(attestation)),\n UNIQUE(household,author,request_id)\n);\nCREATE INDEX diary_e2ee_record_household ON diary_e2ee_records(household,id);\nCREATE UNIQUE INDEX diary_e2ee_edit_draft ON diary_e2ee_records(household,source_id)\n WHERE state='draft' AND source_id IS NOT NULL;\nCREATE TABLE diary_e2ee_changes (\n seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, household TEXT NOT NULL,\n revision INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1))\n);\nCREATE TRIGGER diary_e2ee_created AFTER INSERT ON diary_e2ee_records BEGIN\n INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(NEW.id,NEW.household,NEW.revision,0);\nEND;\nCREATE TRIGGER diary_e2ee_updated AFTER UPDATE ON diary_e2ee_records BEGIN\n INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(NEW.id,NEW.household,NEW.revision,0);\nEND;\nCREATE TRIGGER diary_e2ee_deleted AFTER DELETE ON diary_e2ee_records BEGIN\n INSERT INTO diary_e2ee_changes(id,household,revision,deleted) VALUES(OLD.id,OLD.household,OLD.revision+1,1);\nEND;\nCREATE INDEX diary_e2ee_change_household ON diary_e2ee_changes(household,seq);\nCREATE TABLE diary_e2ee_requests (\n household TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL,\n fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)),\n PRIMARY KEY(household,account_id,request_id)\n);\n\n-- Opaque IDs only. A later media adapter drains this queue after cutover.\n-- Enqueue is transactional; IDs cannot be reattached after retirement.\nCREATE TABLE diary_e2ee_media_gc (\n photo_id TEXT PRIMARY KEY, household TEXT NOT NULL, mutation_id TEXT NOT NULL\n);\nCREATE TABLE diary_e2ee_media (\n id TEXT PRIMARY KEY,household TEXT NOT NULL,account_id TEXT NOT NULL,session_id TEXT NOT NULL,\n status TEXT NOT NULL CHECK(status IN ('uploading','ready','attached','retiring')),\n original_key TEXT NOT NULL,display_key TEXT NOT NULL,thumbnail_key TEXT NOT NULL,\n metadata TEXT NOT NULL CHECK(json_valid(metadata)),epoch INTEGER NOT NULL,\n request_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,retired_at INTEGER\n);\nCREATE TABLE diary_e2ee_uploads (\n id TEXT PRIMARY KEY,household TEXT NOT NULL,account_id TEXT NOT NULL,target_id TEXT,\n status TEXT NOT NULL CHECK(status IN ('active','committed','retiring')),\n expires_at INTEGER NOT NULL,committed_entry TEXT,committed_ids TEXT\n);\n\n-- Storage, rather than a browser flag, is the final write fence.\nCREATE TRIGGER diary_e2ee_write_insert BEFORE INSERT ON diary_e2ee_records\n WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused') NOT IN ('encrypted','migrating','restoring')\n BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_write_update BEFORE UPDATE ON diary_e2ee_records\n WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused') NOT IN ('encrypted','rekeying')\n BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_write_delete BEFORE DELETE ON diary_e2ee_records\n WHEN COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1),'paused')!='encrypted'\n BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_no_plaintext_downgrade BEFORE UPDATE ON diary_e2ee_control\n WHEN OLD.ever_encrypted=1 AND (NEW.ever_encrypted!=1 OR NEW.phase IN ('legacy','migrating','restoring'))\n BEGIN SELECT RAISE(ABORT,'PlaintextRollbackForbidden'); END;\nCREATE TRIGGER diary_e2ee_control_required BEFORE DELETE ON diary_e2ee_control\n BEGIN SELECT RAISE(ABORT,'RolloutControlRequired'); END;\nCREATE TRIGGER diary_e2ee_media_insert_fence BEFORE INSERT ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) IN ('encrypted','migrating','restoring'),0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_media_update_fence BEFORE UPDATE ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) IN ('encrypted','rekeying'),0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_media_delete_fence BEFORE DELETE ON diary_e2ee_media WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_uploads_insert_fence BEFORE INSERT ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) IN ('encrypted','migrating','restoring'),0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_uploads_update_fence BEFORE UPDATE ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_e2ee_uploads_delete_fence BEFORE DELETE ON diary_e2ee_uploads WHEN NOT COALESCE((SELECT phase FROM diary_e2ee_control WHERE id=1) ='encrypted',0) BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\n\n-- Paused, signed rekey staging contains ciphertext only. No R2 byte rewrite.\nCREATE TABLE diary_e2ee_rotation (\n id INTEGER PRIMARY KEY CHECK(id=1), manifest TEXT NOT NULL CHECK(json_valid(manifest)),\n configuration TEXT NOT NULL CHECK(json_valid(configuration)),\n status TEXT NOT NULL CHECK(status IN ('staging','committed')),\n control_generation INTEGER NOT NULL CHECK(control_generation>=0), sequence INTEGER NOT NULL CHECK(sequence>=0)\n);\nCREATE TABLE diary_e2ee_rotation_items (\n kind TEXT NOT NULL CHECK(kind IN ('records','media')), id TEXT NOT NULL,\n payload TEXT NOT NULL CHECK(json_valid(payload)), previous_digest TEXT NOT NULL, PRIMARY KEY(kind,id)\n);\n\n-- Apply manually ONLY after the normal schema and before beginning migration.\n-- Keeping this outside migrations prevents automatic production application.\n-- Old Worker versions are also stopped by these DB guards. They must never be\n-- used as an encrypted-data rollback target: they cannot read ciphertext.\nCREATE TRIGGER diary_plaintext_entry_insert BEFORE INSERT ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_entry_update BEFORE UPDATE ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_entry_delete BEFORE DELETE ON diary_entries WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_tag_insert BEFORE INSERT ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_tag_update BEFORE UPDATE ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_tag_delete BEFORE DELETE ON diary_tags WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_photo_insert BEFORE INSERT ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_photo_update BEFORE UPDATE ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_photo_delete BEFORE DELETE ON diary_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_favorite_insert BEFORE INSERT ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_favorite_update BEFORE UPDATE ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_favorite_delete BEFORE DELETE ON diary_favorites WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_upload_insert BEFORE INSERT ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_upload_update BEFORE UPDATE ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_upload_delete BEFORE DELETE ON diary_photo_upload_sessions WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_staged_insert BEFORE INSERT ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_staged_update BEFORE UPDATE ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_staged_delete BEFORE DELETE ON diary_staged_photos WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_scope_insert BEFORE INSERT ON diary_trash_scopes WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_scope_update BEFORE UPDATE ON diary_trash_scopes WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_scope_delete BEFORE DELETE ON diary_trash_scopes WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1) NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_investment_insert BEFORE INSERT ON investment_history WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_investment_update BEFORE UPDATE ON investment_history WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)!='legacy' BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\nCREATE TRIGGER diary_plaintext_investment_delete BEFORE DELETE ON investment_history WHEN (SELECT phase FROM diary_e2ee_control WHERE id=1)NOT IN ('legacy','purging') BEGIN SELECT RAISE(ABORT,'DiaryWritesPaused'); END;\n";

// backup-worker/src/integrity.js
var MAX_OBJECT_BYTES = 16 * 1024 * 1024;
async function readBounded(stream, max = MAX_OBJECT_BYTES) {
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new Error("SnapshotTooLarge");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
var hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
var digest = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
var objectBytes = (object) => readBounded(object.body);
async function decode(bytes) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")))));
}
async function verifiedGeneration(bucket, key, validate) {
  const object = await bucket.get(key);
  if (!object) return null;
  if (!/^[a-f0-9]{64}$/.test(object.customMetadata?.sha256 || "")) throw new Error("LegacyGenerationUnverified");
  const bytes = await objectBytes(object);
  if (await digest(bytes) !== object.customMetadata.sha256) throw new Error("VerificationFailed");
  const payload = await decode(bytes);
  await validate(payload);
  return { bytes, payload, sha256: object.customMetadata.sha256, etag: object.etag };
}

// diary-worker/e2ee/crypto.mjs
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var VERSION = 1;
var RECOVERY_RECIPIENT = "__recovery__";
var canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(
  Object.keys(value).sort().map((k) => [k, canonical(value[k])])
) : value;
var encode = (value) => encoder.encode(JSON.stringify(canonical(value)));
var b64 = (value) => {
  const bytes = new Uint8Array(value);
  if (bytes.toBase64)
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(chunks.join("")).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
function base64Length(value, max) {
  if (typeof value !== "string" || !value.length || value.length > max || !/^[\w-]+$/.test(value) || value.length % 4 === 1)
    throw new Error("InvalidEnvelope");
  return Math.floor(value.length * 3 / 4);
}
function unb64(value, max = 2e6) {
  base64Length(value, max);
  if (Uint8Array.fromBase64)
    return Uint8Array.fromBase64(value, { alphabet: "base64url" });
  const text = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4)
  );
  const result = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
  return result;
}
function validateEnvelope(value) {
  if (!value || Object.keys(value).sort().join(",") !== "ciphertext,iv,version" || ![1, 2].includes(value.version) || unb64(value.iv, 16).length !== 12 || base64Length(value.ciphertext, 2e6) < 16)
    throw new Error("InvalidEnvelope");
  return value;
}
async function fingerprint(publicKey) {
  return b64(
    await crypto.subtle.digest(
      "SHA-256",
      encode({
        kty: publicKey.kty,
        crv: publicKey.crv,
        x: publicKey.x,
        y: publicKey.y,
        n: publicKey.n,
        e: publicKey.e
      })
    )
  );
}
function validatePublicKey(key, kind) {
  const signing = kind === "signing";
  const fields = signing ? ["kty", "crv", "x", "y"] : ["kty", "n", "e"];
  const allowed = /* @__PURE__ */ new Set([...fields, "alg", "ext", "key_ops"]);
  if (!key || typeof key !== "object" || Array.isArray(key) || !["signing", "recipient", "recovery"].includes(kind) || fields.some((name) => !Object.hasOwn(key, name)) || Object.keys(key).some((name) => !allowed.has(name)) || Object.hasOwn(key, "ext") && typeof key.ext !== "boolean" || Object.hasOwn(key, "alg") && key.alg !== (signing ? "ES256" : "RSA-OAEP-256") || Object.hasOwn(key, "key_ops") && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== (signing ? "verify" : "encrypt")))
    throw new Error("InvalidPublicKey");
  if (signing) {
    if (key.kty !== "EC" || key.crv !== "P-256" || unb64(key.x, 43).length !== 32 || unb64(key.y, 43).length !== 32)
      throw new Error("InvalidPublicKey");
  } else if (key.kty !== "RSA" || key.e !== "AQAB" || !(kind === "recovery" ? [384, 512] : [384]).includes(unb64(key.n, 684).length)) {
    throw new Error("InvalidPublicKey");
  }
  return key;
}
var recoveryWrappedBytes = (key) => unb64(validatePublicKey(key, "recovery").n, 684).length;
async function verifySigned(packet, publicKey) {
  validatePublicKey(publicKey, "signing");
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    unb64(packet.signature, 100),
    encode(packet.value)
  ))
    throw new Error("InvalidSignature");
  return packet.value;
}
async function verifyDirectory(packet, anchor, minimumGeneration = 1) {
  const value = await verifySigned(packet, anchor);
  if (value.protocol !== "T-lain diary directory" || value.version !== VERSION || !Number.isSafeInteger(value.generation) || value.generation < minimumGeneration || !Array.isArray(value.members))
    throw new Error("StaleDirectory");
  if (!value.epochs || !value.households || value.members.length > 100)
    throw new Error("InvalidDirectory");
  const token2 = (v) => typeof v === "string" && /^[\w:-]{1,160}$/.test(v);
  for (const [scope, epoch] of Object.entries(value.epochs))
    if (!token2(scope) || !Number.isSafeInteger(epoch) || epoch < 1)
      throw new Error("InvalidDirectory");
  for (const [household, config] of Object.entries(value.households))
    if (!token2(household) || !token2(config.owner) || typeof config.independent !== "boolean")
      throw new Error("InvalidDirectory");
  if (!recoveryWrappedBytes(value.recoveryPublicKey) || await fingerprint(value.recoveryPublicKey) !== value.recoveryFingerprint)
    throw new Error("InvalidDirectory");
  if (value.recoveryAuthority && b64(encode(value.recoveryAuthority)) !== b64(encode(anchor)))
    throw new Error("InvalidRecoveryAuthority");
  const ids = /* @__PURE__ */ new Set();
  for (const member of value.members) {
    if (member.credentialId === RECOVERY_RECIPIENT || ids.has(member.credentialId) || !/^[\w-]{1,2048}$/.test(member.credentialId) || !token2(member.accountId) || !Array.isArray(member.scopes) || new Set(member.scopes).size !== member.scopes.length || member.scopes.some((s) => !Object.hasOwn(value.epochs, s)) || await fingerprint(member.publicKey) !== member.fingerprint || typeof member.canManageEntries !== "boolean" || !Array.isArray(member.households) || member.households.some((h) => !Object.hasOwn(value.households, h)))
      throw new Error("InvalidDirectory");
    validatePublicKey(member.publicKey, "recipient");
    validatePublicKey(member.signPublicKey, "signing");
    await crypto.subtle.importKey(
      "jwk",
      member.signPublicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    ids.add(member.credentialId);
  }
  return value;
}

// diary-worker/e2ee/policy.mjs
var publishedScope = (household) => `${household}:published`;
var investmentScope = (household) => `${household}:investment`;
var draftScope = (household) => `${household}:drafts`;
var preferencesScope = (household, account) => `${household}:preferences:${account}`;
function trashScope(household, accounts) {
  return `${household}:trash:${[...accounts].sort().join(":")}`;
}

// diary-worker/e2ee/record.mjs
var exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
var token = (value) => typeof value === "string" && /^[\w:-]{1,160}$/.test(value);
var ROW_KEYS = [
  "id",
  "household",
  "scope",
  "state",
  "author",
  "revision",
  "epoch",
  "sourceId",
  "sourceRevision",
  "retainedFor",
  "envelope",
  "summary",
  "photoIds",
  "keyBox",
  "attestation"
];
var bindingOf = (row) => Object.fromEntries(
  [
    "id",
    "household",
    "state",
    "author",
    "revision",
    "retainedFor",
    "sourceId",
    "sourceRevision",
    "epoch",
    "scope",
    "photoIds"
  ].map((key) => [key, row[key]])
);
var proofOf = (row) => ({
  binding: bindingOf(row),
  envelope: row.envelope,
  summary: row.summary,
  keyBox: row.keyBox,
  writer: row.attestation.writer,
  ...row.attestation.recovery ? { recovery: row.attestation.recovery } : {}
});
function validateRecord(row) {
  if (!exact(row, ROW_KEYS) || !["id", "household", "scope", "author"].every((k) => token(row[k])) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.epoch) || row.epoch < 1 || !["published", "draft", "trash", "preferences", "investment"].includes(row.state))
    throw new Error("InvalidRecord");
  if (row.sourceId !== null && !token(row.sourceId) || row.sourceRevision !== null && (!Number.isSafeInteger(row.sourceRevision) || row.sourceRevision < 1) || Boolean(row.sourceId) !== Boolean(row.sourceRevision))
    throw new Error("InvalidRecord");
  if (!Array.isArray(row.retainedFor) || row.retainedFor.length > 100 || row.retainedFor.some((id) => !token(id)) || new Set(row.retainedFor).size !== row.retainedFor.length || row.state === "trash" !== Boolean(row.retainedFor.length))
    throw new Error("InvalidRecord");
  if (row.state === "investment" ? row.id !== investmentScope(row.household) || row.sourceId !== null || row.photoIds?.length !== 0 : row.state === "preferences" ? row.id !== preferencesScope(row.household, row.author) : !/^[1-9][0-9]{0,15}$/.test(row.id) || !Number.isSafeInteger(Number(row.id)))
    throw new Error("InvalidRecord");
  const scope = row.state === "investment" ? investmentScope(row.household) : row.state === "published" ? publishedScope(row.household) : row.state === "draft" ? draftScope(row.household) : row.state === "preferences" ? preferencesScope(row.household, row.author) : trashScope(row.household, row.retainedFor);
  if (scope !== row.scope || !Array.isArray(row.photoIds) || row.photoIds.length > 5e3 || new Set(row.photoIds).size !== row.photoIds.length || row.photoIds.some(
    (id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)
  ))
    throw new Error("InvalidRecord");
  validateEnvelope(row.envelope);
  validateEnvelope(row.summary);
  if (!exact(row.attestation, ["writer", "signature", ...row.attestation?.recovery ? ["recovery"] : []]) || !/^[\w-]{1,2048}$/.test(row.attestation.writer) || unb64(row.attestation.signature, 100).length !== 64 || !row.keyBox || typeof row.keyBox !== "object" || Array.isArray(row.keyBox) || Object.keys(row.keyBox).length > 100)
    throw new Error("InvalidRecord");
  for (const [id, value] of Object.entries(row.keyBox))
    if (!/^[\w-]{1,2048}$/.test(id) || !(id === RECOVERY_RECIPIENT ? [384, 512] : [384]).includes(
      unb64(value, id === RECOVERY_RECIPIENT ? 684 : 512).length
    ))
      throw new Error("InvalidRecord");
  return row;
}
async function verifyRecord(row, directory, { currentRecipients = false } = {}) {
  validateRecord(row);
  if (row.state === "investment" && (directory.households[row.household]?.independent !== false || row.author !== directory.households[row.household]?.owner)) throw new Error("InvalidInvestmentRecord");
  if (row.keyBox[RECOVERY_RECIPIENT] && unb64(row.keyBox[RECOVERY_RECIPIENT], 684).length !== recoveryWrappedBytes(directory.recoveryPublicKey))
    throw new Error("InvalidRecipients");
  if (row.attestation.writer === RECOVERY_RECIPIENT) {
    const proof = row.attestation.recovery;
    if (!directory.recoveryAuthority || !exact(proof, ["operation", "previousDigest", "previousGeneration", "directoryGeneration"]) || !["rekey", "migration"].includes(proof.operation) || !/^[\w-]{43}$/.test(proof.previousDigest) || !Number.isSafeInteger(proof.previousGeneration) || proof.previousGeneration < (proof.operation === "migration" ? 0 : 1) || proof.operation === "migration" && proof.previousGeneration !== 0 || !Number.isSafeInteger(proof.directoryGeneration) || proof.directoryGeneration > directory.generation || proof.previousGeneration >= proof.directoryGeneration || directory.epochs[row.scope] !== row.epoch || Object.keys(row.keyBox).length)
      throw new Error("InvalidRecoveryAttestation");
    await verifySigned({ value: proofOf(row), signature: row.attestation.signature }, directory.recoveryAuthority);
    return row;
  }
  if (row.attestation.recovery) throw new Error("InvalidRecoveryAttestation");
  const member = directory.members.find(
    (m) => m.credentialId === row.attestation.writer
  );
  if (!member || !member.households.includes(row.household) || (row.state === "investment" ? member.accountId !== row.author || !member.canManageEntries : row.state === "preferences" ? member.accountId !== row.author : !member.canManageEntries))
    throw new Error("UnauthorizedWriter");
  if (directory.epochs[row.scope] !== row.epoch)
    throw new Error("KeyEpochConflict");
  const expected = directory.members.filter((m) => m.scopes.includes(row.scope)).map((m) => m.credentialId).sort();
  expected.push(RECOVERY_RECIPIENT);
  expected.sort();
  const actual = Object.keys(row.keyBox).sort();
  if (actual.length && (!actual.includes(RECOVERY_RECIPIENT) || actual.some((id) => !expected.includes(id)) || currentRecipients && b64(encode(actual)) !== b64(encode(expected))))
    throw new Error("InvalidRecipients");
  await verifySigned(
    { value: proofOf(row), signature: row.attestation.signature },
    member.signPublicKey
  );
  return row;
}

// diary-worker/e2ee/investment.mjs
var INVESTMENT_VALUES = Object.freeze(["total", "cash", "stocks", "funds", "bonds", "crypto", "futures", "points", "other"]);

// diary-worker/e2ee/rollout.mjs
var READ_FORMATS = Object.freeze([1, 2]);

// diary-worker/e2ee/store.mjs
var recordBytesSQL = ["envelope", "summary", "key_box", "photo_ids", "attestation"].map((column) => `length(CAST(${column} AS BLOB))`).join("+") + "+1000";
var parseRecord = (row) => row ? {
  id: row.id,
  household: row.household,
  scope: row.scope,
  state: row.state,
  author: row.author,
  revision: row.revision,
  epoch: row.epoch,
  sourceId: row.source_id,
  sourceRevision: row.source_revision,
  retainedFor: JSON.parse(row.retained_for),
  envelope: JSON.parse(row.envelope),
  summary: JSON.parse(row.summary),
  photoIds: JSON.parse(row.photo_ids),
  keyBox: JSON.parse(row.key_box),
  attestation: JSON.parse(row.attestation)
} : null;

// diary-worker/src/entry-domain.js
function createDiaryEntryDomain({ HttpError, basePath }) {
  function validateEntryInput(body, { draft = false, allowEmptyContent = false } = {}) {
    const entryDate = typeof body.entryDate === "string" ? body.entryDate.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!isValidDate(entryDate)) throw new HttpError(400, "\u65E5\u4ED8\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    if (!draft && !title || title.length > 200) throw new HttpError(400, "\u30BF\u30A4\u30C8\u30EB\u306F1\u6587\u5B57\u4EE5\u4E0A200\u6587\u5B57\u4EE5\u5185\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    if (!draft && !allowEmptyContent && !content || content.length > 2e5) throw new HttpError(400, "\u672C\u6587\u306F1\u6587\u5B57\u4EE5\u4E0A20\u4E07\u6587\u5B57\u4EE5\u5185\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    const rawTags = Array.isArray(body.tags) ? body.tags : [];
    const tags = [...new Set(rawTags.map(normalizeTag).filter(Boolean))];
    if (tags.length > 100 || tags.some((tag) => tag.length > 30)) {
      throw new HttpError(400, "\u30BF\u30B0\u306F100\u500B\u307E\u3067\u30011\u500B30\u6587\u5B57\u4EE5\u5185\u3067\u5165\u529B\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    const contentFormat = validateContentFormat(body.contentFormat, content);
    const excludedPhotoIds = parsePhotoIdList(body.excludedPhotoIds);
    const weather = body.weather ?? null;
    if (weather !== null && !["sunny", "cloudy", "partly_cloudy", "cloudy_rain", "rain", "heavy_rain", "thunder", "snow"].includes(weather)) {
      throw new HttpError(400, "\u5929\u6C17\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    return { entryDate, title, content, contentFormat, tags, excludedPhotoIds, weather };
  }
  function normalizeEntryStatus(value) {
    return value === "draft" ? "draft" : "published";
  }
  function parsePhotoIdList(value) {
    let source = value;
    if (typeof source === "string") {
      try {
        source = JSON.parse(source);
      } catch {
        source = [];
      }
    }
    if (!Array.isArray(source)) return [];
    return [...new Set(source.map((item) => String(item || "").toLowerCase()).filter(isUuid))];
  }
  function validateContentFormat(value, content) {
    if (value == null || value === "") return null;
    if (!value || typeof value !== "object" || value.version !== 1 || !Array.isArray(value.runs)) {
      throw new HttpError(400, "\u672C\u6587\u306E\u66F8\u5F0F\u60C5\u5831\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
    }
    if (value.runs.length > 5e3) {
      throw new HttpError(400, "\u672C\u6587\u306E\u66F8\u5F0F\u304C\u591A\u3059\u304E\u307E\u3059\u3002");
    }
    const colors = /* @__PURE__ */ new Set(["red", "blue", "green", "orange", "purple", "gray", "light-blue", "brown"]);
    const normalized = [];
    let previousEnd = 0;
    for (const run of value.runs) {
      const start = Number(run?.start);
      const end = Number(run?.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < previousEnd || start < 0 || end <= start || end > content.length) {
        throw new HttpError(400, "\u672C\u6587\u306E\u66F8\u5F0F\u7BC4\u56F2\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      const color = run.color == null || run.color === "" ? null : String(run.color);
      if (color && !colors.has(color)) {
        throw new HttpError(400, "\u672C\u6587\u306E\u6587\u5B57\u8272\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      const item = {
        start,
        end,
        bold: run.bold === true,
        italic: run.italic === true,
        underline: run.underline === true,
        color
      };
      if (!item.bold && !item.italic && !item.underline && !item.color) {
        throw new HttpError(400, "\u672C\u6587\u306E\u66F8\u5F0F\u60C5\u5831\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044\u3002");
      }
      normalized.push(item);
      previousEnd = end;
    }
    return normalized.length ? JSON.stringify({ version: 1, runs: normalized }) : null;
  }
  function serializePhoto(row) {
    return {
      id: row.id,
      entryId: Number(row.entry_id),
      entryDate: row.entry_date || null,
      entryTitle: row.entry_title || null,
      authorId: row.author_id || null,
      authorName: row.author_name || null,
      fileName: row.file_name,
      contentType: row.content_type,
      originalSize: Number(row.original_size || 0),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      createdByName: row.created_by_name,
      createdAt: row.created_at,
      thumbnailUrl: `${basePath}/api/photos/${row.id}/thumbnail`,
      displayUrl: `${basePath}/api/photos/${row.id}/display`,
      originalUrl: `${basePath}/api/photos/${row.id}/original`
    };
  }
  function serializeEntry(row) {
    let tags = [];
    try {
      tags = JSON.parse(row.tags || "[]");
    } catch {
      tags = [];
    }
    return {
      id: Number(row.id),
      entryDate: row.entry_date,
      lastPublishedAt: row.last_published_at ?? null,
      title: row.title,
      weather: row.weather ?? null,
      content: row.content,
      contentFormat: parseContentFormat(row.content_format),
      authorId: row.author_id,
      authorName: row.author_name,
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      deletedById: row.deleted_by_id || null,
      deletedByName: row.deleted_by_name || null,
      status: row.status || "published",
      isFavorite: Number(row.is_favorite || 0) === 1,
      draftOfEntryId: row.draft_of_entry_id == null ? null : Number(row.draft_of_entry_id),
      draftOfRevision: row.draft_of_revision == null ? null : Number(row.draft_of_revision),
      excludedPhotoIds: parsePhotoIdList(row.draft_excluded_photo_ids),
      revision: Number(row.revision)
    };
  }
  function parseContentFormat(value) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed?.version === 1 && Array.isArray(parsed.runs) ? parsed : null;
    } catch {
      return null;
    }
  }
  function normalizeTag(value) {
    return String(value || "").trim().replace(/^#+/, "").replace(/\s+/g, " ");
  }
  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
  }
  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = /* @__PURE__ */ new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  return Object.freeze({ validateEntryInput, normalizeEntryStatus, parsePhotoIdList, validateContentFormat, serializePhoto, serializeEntry, parseContentFormat, normalizeTag, isUuid, isValidDate });
}

// diary-worker/e2ee/migration.mjs
var domain = createDiaryEntryDomain({ HttpError: Error, basePath: "/diary" });
var LEGACY_TABLES = Object.freeze(["diary_entries", "diary_tags", "diary_photos", "diary_trash_scopes", "diary_favorites", "investment_history"]);

// diary-worker/e2ee/trust.mjs
var TRUST_PIN = "tlain-diary-authority-public-v1";
function validateSealedTrust(packet, maxBytes = 12e3) {
  if (!packet || Object.keys(packet).sort().join(",") !== "envelope,generation" || !Number.isSafeInteger(packet.generation) || packet.generation < 1 || encode(packet).length > maxBytes) throw new Error("InvalidPasskeyTrust");
  validateEnvelope(packet.envelope);
  return packet;
}
var FLOOR = TRUST_PIN + "-floor";

// diary-worker/e2ee/backup.mjs
var exact2 = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
async function validateKeyMetadata({ vaults, grants, recordGrants = {}, recoveryEnvelope }, directory, anchor = null) {
  for (const vault of Object.values(vaults || {})) {
    if (!exact2(vault, ["publicKey", "signPublicKey", "privateEnvelope", ...Object.hasOwn(vault, "trust") ? ["trust"] : []]) || [vault.publicKey, vault.signPublicKey].some(
      (key) => !key || ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(
        (name) => Object.hasOwn(key, name)
      )
    ))
      throw new Error("InvalidKeyMetadata");
    validateEnvelope(vault.privateEnvelope);
    if (vault.trust) {
      validateSealedTrust(vault.trust);
      if (vault.trust.generation > directory.generation) throw new Error("InvalidKeyMetadata");
    }
    validatePublicKey(vault.publicKey, "recipient");
    validatePublicKey(vault.signPublicKey, "signing");
  }
  for (const [record, collections] of [[false, grants], [true, recordGrants]]) for (const list of Object.values(collections || {})) {
    if (!Array.isArray(list)) throw new Error("InvalidKeyMetadata");
    for (const grant of list) {
      if (!exact2(grant, ["value", "signature"]) || !exact2(grant.value, [
        "version",
        "household",
        "scope",
        "epoch",
        "accountId",
        "credentialId",
        "fingerprint",
        "directoryGeneration",
        "wrapped",
        ...record ? ["id", "revision", "kind"] : []
      ]) || unb64(grant.signature, 100).length !== 64 || unb64(grant.value.wrapped, 512).length !== 384)
        throw new Error("InvalidKeyMetadata");
      if (anchor) {
        const value = await verifySigned(grant, anchor);
        const member = directory.members.find((m) => m.credentialId === value.credentialId && m.accountId === value.accountId);
        if (!member || value.version !== 1 || value.directoryGeneration !== directory.generation || value.fingerprint !== member.fingerprint || !member.scopes.includes(value.scope) || value.epoch !== directory.epochs[value.scope] || !value.scope.startsWith(value.household + ":") || record && (value.kind !== "record" || !Number.isSafeInteger(value.revision) || value.revision < 1))
          throw new Error("InvalidKeyMetadata");
      }
    }
  }
  if (recoveryEnvelope !== null) {
    if (!exact2(recoveryEnvelope, [
      "version",
      "generation",
      "authority",
      "recoveryFingerprint",
      "envelope",
      "wrappedKey"
    ]) || recoveryEnvelope.version !== 1 || unb64(recoveryEnvelope.wrappedKey, 684).length !== recoveryWrappedBytes(directory.recoveryPublicKey) || recoveryEnvelope.generation !== directory.generation || anchor && recoveryEnvelope.authority !== await fingerprint(anchor) || recoveryEnvelope.recoveryFingerprint !== directory.recoveryFingerprint)
      throw new Error("InvalidKeyMetadata");
    validateEnvelope(recoveryEnvelope.envelope);
  }
}

// backup-worker/src/diary-encrypted.js
var DIARY_ENCRYPTED_MIGRATION = "diary-e2ee-v1";
var SECURITY_DIARY_MIGRATION = "security-diary-keys-v1";
var table = (name, columns) => ({ name, columns: columns.split(","), sourceColumns: columns });
var ENCRYPTED_DIARY_TABLES = [
  table("diary_e2ee_control", "id,phase,generation,ever_encrypted,evidence"),
  table("diary_e2ee_records", "id,household,scope,state,author,revision,epoch,source_id,source_revision,retained_for,envelope,summary,photo_ids,request_id,mutation_id,key_box,attestation"),
  table("diary_e2ee_changes", "seq,id,household,revision,deleted"),
  table("diary_e2ee_requests", "household,account_id,request_id,fingerprint,result"),
  table("diary_e2ee_media_gc", "photo_id,household,mutation_id"),
  table("diary_e2ee_media", "id,household,account_id,session_id,status,original_key,display_key,thumbnail_key,metadata,epoch,request_hash,expires_at,retired_at"),
  table("diary_e2ee_uploads", "id,household,account_id,target_id,status,expires_at,committed_entry,committed_ids")
];
var SECURITY_DIARY_TABLES = [
  table("security_diary_key_config", "id,generation,anchor_json,directory_json,recovery_json"),
  table("security_diary_key_vaults", "recipient_id,credential_id,identity_id,service_link_id,account_id,vault_json"),
  table("security_diary_key_grants", "recipient_id,service_link_id,generation,grants_json,record_grants_json")
];
async function verifyEncryptedDiaryRow(table3, row, directory) {
  if (table3 === "diary_e2ee_records") await verifyRecord(parseRecord(row), directory);
  if (table3 === "diary_e2ee_control" && !(row.ever_encrypted && ["encrypted", "paused"].includes(row.phase) || !row.ever_encrypted && row.phase === "migrating")) throw new Error("DiaryBackupRequiresEncryptedSnapshot");
  if (table3 === "diary_e2ee_media") {
    validateEnvelope(JSON.parse(row.metadata));
    if (row.epoch !== directory.epochs[`${row.household}:preferences:${row.account_id}`]) throw new Error("DiaryKeyGenerationConflict");
  }
}

// backup-worker/src/registry.js
var SERVICES = {
  "portfolio": {
    "label": "\u8CC7\u7523\u904B\u7528\u5831\u544A",
    "binding": "PORTFOLIO_DB",
    "database": "portfolio-db",
    "migration": "0001_portfolio.sql",
    "tables": [
      {
        "name": "portfolio_accounts",
        "columns": ["id", "display_name", "role", "is_active", "session_version"],
        "sourceColumns": "id,display_name,role,is_active,session_version"
      },
      {
        "name": "portfolio_state",
        "columns": ["id", "revision", "metadata"],
        "sourceColumns": "id,revision,metadata"
      },
      {
        "name": "portfolio_records",
        "columns": ["period", "time", "raw_market_value", "assets", "updated_at", "updated_by"],
        "sourceColumns": "period,time,raw_market_value,assets,updated_at,updated_by"
      },
      {
        "name": "portfolio_changes",
        "columns": ["revision", "request_id", "fingerprint", "period", "previous_record", "saved_record", "updated_at", "account_id"],
        "sourceColumns": "revision,request_id,fingerprint,period,previous_record,saved_record,updated_at,account_id"
      }
    ],
    "knownTables": ["portfolio_accounts", "portfolio_state", "portfolio_records", "portfolio_changes"]
  },
  "household": {
    "label": "\u5BB6\u8A08\u7C3F",
    "binding": "HOUSEHOLD_DB",
    "database": "household-db",
    "migration": "0007_client_encryption.sql",
    "tables": [
      {
        "name": "household_accounts",
        "columns": [
          "id",
          "display_name",
          "role",
          "is_active",
          "session_version",
          "household_id"
        ],
        "sourceColumns": "id,display_name,role,is_active,session_version,household_id"
      },
      {
        "name": "household_state",
        "columns": [
          "id",
          "revision",
          "active_dataset"
        ],
        "sourceColumns": "id,revision,active_dataset"
      },
      {
        "name": "household_records",
        "columns": [
          "dataset_id",
          "kind",
          "id",
          "payload"
        ],
        "sourceColumns": "dataset_id,kind,id,payload"
      },
      {
        "name": "household_requests",
        "columns": [
          "request_id",
          "fingerprint",
          "response_json",
          "created_at",
          "household_id"
        ],
        "sourceColumns": "request_id,fingerprint,response_json,created_at,household_id"
      },
      {
        "name": "household_datasets",
        "columns": [
          "id",
          "created_at",
          "activated_at",
          "retired_at",
          "lease_expires_at",
          "household_id",
          "crypto_version"
        ],
        "sourceColumns": "id,created_at,activated_at,retired_at,lease_expires_at,household_id,crypto_version"
      },
      {
        "name": "household_crypto_config",
        "columns": [
          "household_id",
          "key_id",
          "recovery_wrapped_key",
          "recovery_public_key"
        ],
        "sourceColumns": "household_id,key_id,recovery_wrapped_key,recovery_public_key"
      },
      {
        "name": "household_crypto_vaults",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key_json",
          "iv",
          "ciphertext"
        ],
        "sourceColumns": "credential_id,identity_id,public_key_json,iv,ciphertext"
      },
      {
        "name": "household_crypto_grants",
        "columns": [
          "household_id",
          "credential_id",
          "identity_id",
          "service_link_id",
          "wrapped_key"
        ],
        "sourceColumns": "household_id,credential_id,identity_id,service_link_id,wrapped_key"
      }
    ],
    "knownTables": [
      "household_accounts",
      "household_state",
      "household_records",
      "household_requests",
      "household_datasets",
      "household_crypto_config",
      "household_crypto_vaults",
      "household_crypto_grants"
    ]
  },
  "cloud": {
    "label": "T-Cloud D1",
    "binding": "CLOUD_DB",
    "database": "cloud-db",
    "migration": "0013_safe_trash_retention.sql",
    "tables": [
      {
        "name": "cloud_folders",
        "columns": [
          "id",
          "parent_id",
          "name",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at",
          "crypto_version",
          "encrypted_name",
          "name_iv",
          "password_salt",
          "password_wrapped_key",
          "password_wrap_iv",
          "admin_wrapped_key",
          "parent_wrapped_key",
          "parent_wrap_iv",
          "trash_operation_id"
        ],
        "sourceColumns": "id,parent_id,name,created_by,created_at,updated_at,deleted_at,password_hash,crypto_version,encrypted_name,name_iv,password_salt,password_wrapped_key,password_wrap_iv,admin_wrapped_key,parent_wrapped_key,parent_wrap_iv,trash_operation_id"
      },
      {
        "name": "cloud_files",
        "columns": [
          "id",
          "folder_id",
          "object_key",
          "thumbnail_key",
          "stream_uid",
          "original_name",
          "mime_type",
          "media_kind",
          "size_bytes",
          "status",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at",
          "crypto_version",
          "encrypted_metadata",
          "metadata_iv",
          "wrapped_file_key",
          "file_key_iv",
          "encrypted_size_bytes",
          "chunk_size_bytes",
          "chunk_count",
          "display_metadata_version",
          "display_name",
          "display_mime_type",
          "display_media_kind",
          "display_last_modified",
          "display_duration_seconds",
          "display_thumbnail_key",
          "trash_operation_id",
          "purge_id"
        ],
        "sourceColumns": "id,folder_id,object_key,thumbnail_key,stream_uid,original_name,mime_type,media_kind,size_bytes,status,multipart_upload_id,created_by,created_at,updated_at,deleted_at,crypto_version,encrypted_metadata,metadata_iv,wrapped_file_key,file_key_iv,encrypted_size_bytes,chunk_size_bytes,chunk_count,display_metadata_version,display_name,display_mime_type,display_media_kind,display_last_modified,display_duration_seconds,display_thumbnail_key,trash_operation_id,purge_id"
      },
      {
        "name": "cloud_crypto_config",
        "columns": [
          "id",
          "crypto_version",
          "public_key_jwk",
          "admin_private_cipher",
          "admin_private_iv",
          "recovery_private_cipher",
          "recovery_private_iv",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,crypto_version,public_key_jwk,admin_private_cipher,admin_private_iv,recovery_private_cipher,recovery_private_iv,created_at,updated_at"
      },
      {
        "name": "cloud_deletion_requests",
        "columns": [
          "id",
          "file_id",
          "file_name",
          "requested_by",
          "status",
          "requested_at",
          "approved_at",
          "approved_by"
        ],
        "sourceColumns": "id,file_id,file_name,requested_by,status,requested_at,approved_at,approved_by"
      },
      {
        "name": "cloud_favorite_files",
        "columns": [
          "owner_id",
          "file_id",
          "created_at"
        ],
        "sourceColumns": "owner_id,file_id,created_at"
      },
      {
        "name": "cloud_favorite_folders",
        "columns": [
          "owner_id",
          "folder_id",
          "created_at"
        ],
        "sourceColumns": "owner_id,folder_id,created_at"
      },
      {
        "name": "cloud_audit_logs",
        "columns": [
          "id",
          "event_type",
          "actor_role",
          "target_type",
          "target_id",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_role,target_type,target_id,details_json,occurred_at"
      },
      {
        "name": "cloud_security_events",
        "columns": [
          "id",
          "event_type",
          "actor_role",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_role,details_json,occurred_at"
      },
      {
        "name": "cloud_trash_operations",
        "columns": ["id", "deleted_at", "target_type", "target_id", "purge_started"],
        "sourceColumns": "id,deleted_at,target_type,target_id,purge_started"
      },
      {
        "name": "cloud_trash_purges",
        "columns": ["id", "file_id", "operation_id", "deleted_at", "folder_id", "object_key", "thumbnail_key", "display_thumbnail_key", "stream_uid", "size_bytes", "source", "run_id", "phase", "created_at", "completed_at"],
        "sourceColumns": "id,file_id,operation_id,deleted_at,folder_id,object_key,thumbnail_key,display_thumbnail_key,stream_uid,size_bytes,source,run_id,phase,created_at,completed_at"
      },
      {
        "name": "cloud_trash_folder_purges",
        "columns": ["id", "folder_id", "parent_id", "operation_id", "deleted_at", "run_id", "source", "occurred_at"],
        "sourceColumns": "id,folder_id,parent_id,operation_id,deleted_at,run_id,source,occurred_at"
      }
    ],
    "knownTables": [
      "cloud_folders",
      "cloud_files",
      "cloud_audit_logs",
      "cloud_login_attempts",
      "cloud_folder_unlocks",
      "cloud_deletion_requests",
      "cloud_crypto_config",
      "cloud_security_events",
      "cloud_shares",
      "cloud_share_attempts",
      "cloud_share_events",
      "cloud_share_files",
      "cloud_usage_summary",
      "cloud_share_folders",
      "cloud_favorite_files",
      "cloud_favorite_folders",
      "cloud_trash_operations",
      "cloud_trash_control",
      "cloud_trash_purges",
      "cloud_trash_folder_purges"
    ]
  },
  "security": {
    "label": "Security Center",
    "binding": "SECURITY_DB",
    "database": "security-db",
    "migration": "0030_portfolio_service.sql",
    "tables": [
      {
        "name": "security_identities",
        "columns": [
          "id",
          "display_name",
          "status",
          "is_security_admin",
          "last_login_at",
          "created_at",
          "updated_at",
          "last_seen_at"
        ],
        "sourceColumns": "id,display_name,status,is_security_admin,last_login_at,created_at,updated_at,last_seen_at"
      },
      {
        "name": "security_invitations",
        "columns": [
          "id",
          "identity_id",
          "token_hash",
          "link_set_hash",
          "expires_at",
          "status",
          "created_by_identity_id",
          "created_at",
          "used_at",
          "revoked_at"
        ],
        "sourceColumns": "id,identity_id,token_hash,link_set_hash,expires_at,status,created_by_identity_id,created_at,used_at,revoked_at"
      },
      {
        "name": "security_credentials",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key",
          "counter",
          "transports_json",
          "device_type",
          "backed_up",
          "prf_enabled",
          "prf_salt",
          "status",
          "label",
          "registered_at",
          "approved_at",
          "last_used_at",
          "revoked_at",
          "registered_via_invitation_id"
        ],
        "sourceColumns": "credential_id,identity_id,public_key,counter,transports_json,device_type,backed_up,prf_enabled,prf_salt,status,label,registered_at,approved_at,last_used_at,revoked_at,registered_via_invitation_id"
      },
      {
        "name": "security_service_links",
        "columns": [
          "id",
          "identity_id",
          "service",
          "service_account_id",
          "cloud_root_folder_id",
          "display_label",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,service,service_account_id,cloud_root_folder_id,display_label,status,created_at,updated_at"
      },
      {
        "name": "security_tcloud_client_vaults",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key_jwk",
          "public_key_fingerprint",
          "encrypted_payload",
          "payload_iv",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "credential_id,identity_id,public_key_jwk,public_key_fingerprint,encrypted_payload,payload_iv,created_at,updated_at"
      },
      {
        "name": "security_tcloud_key_envelopes",
        "columns": [
          "id",
          "identity_id",
          "credential_id",
          "service_link_id",
          "envelope_type",
          "public_key_jwk",
          "encrypted_payload",
          "payload_iv",
          "wrapped_key",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,credential_id,service_link_id,envelope_type,public_key_jwk,encrypted_payload,payload_iv,wrapped_key,created_at,updated_at"
      },
      {
        "name": "security_health_members",
        "columns": [
          "slot",
          "identity_id"
        ],
        "sourceColumns": "slot,identity_id"
      },
      {
        "name": "security_health_config",
        "columns": [
          "account_id",
          "recovery_wrapped_key",
          "recovery_public_key"
        ],
        "sourceColumns": "account_id,recovery_wrapped_key,recovery_public_key"
      },
      {
        "name": "security_health_vaults",
        "columns": [
          "credential_id",
          "identity_id",
          "public_key_json",
          "iv",
          "ciphertext"
        ],
        "sourceColumns": "credential_id,identity_id,public_key_json,iv,ciphertext"
      },
      {
        "name": "security_health_grants",
        "columns": [
          "identity_id",
          "credential_id",
          "service_link_id",
          "wrapped_key"
        ],
        "sourceColumns": "identity_id,credential_id,service_link_id,wrapped_key"
      },
      {
        "name": "security_ai_budget_policies",
        "columns": [
          "identity_id",
          "monthly_budget_jpy",
          "soft_stop_jpy",
          "hard_stop_jpy",
          "reserve_enabled",
          "reserve_period",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,monthly_budget_jpy,soft_stop_jpy,hard_stop_jpy,reserve_enabled,reserve_period,created_at,updated_at"
      },
      {
        "name": "security_audit_events",
        "columns": [
          "event_id",
          "occurred_at",
          "received_at",
          "service",
          "event_type",
          "outcome",
          "identity_id",
          "service_account_id",
          "role",
          "auth_method",
          "session_id_hash",
          "source_hash",
          "user_agent",
          "target_type",
          "target_id",
          "details_json",
          "service_link_id",
          "service_account_label"
        ],
        "sourceColumns": "event_id,occurred_at,received_at,service,event_type,outcome,identity_id,service_account_id,role,auth_method,session_id_hash,source_hash,user_agent,target_type,target_id,details_json,service_link_id,service_account_label"
      }
    ],
    "knownTables": [
      "security_identities",
      "security_invitations",
      "security_credentials",
      "security_challenges",
      "security_tcloud_client_vaults",
      "security_setup_sessions",
      "security_runtime_state",
      "security_ai_budget_policies",
      "security_definition_updates",
      "security_definition_events",
      "security_audit_daily",
      "security_health_members",
      "security_health_config",
      "security_health_vaults",
      "security_service_links",
      "security_handoffs",
      "security_tcloud_key_envelopes",
      "security_health_grants",
      "security_audit_events",
      "security_active_sessions"
    ]
  },
  "billing": {
    "label": "\u8ACB\u6C42\u66F8\u7BA1\u7406",
    "binding": "BILLING_DB",
    "database": "billing-db",
    "migration": "0008_password_auth_policy.sql",
    "tables": [
      {
        "name": "billing_accounts",
        "columns": [
          "id",
          "login_id",
          "display_name",
          "role",
          "session_version",
          "is_active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,login_id,display_name,role,password_salt,password_hash,password_iterations,session_version,is_active,created_at,updated_at,failed_login_attempts,locked_until,password_pepper_version"
      },
      {
        "name": "billing_opening_balances",
        "columns": [
          "account_id",
          "effective_date",
          "balance_yen",
          "updated_by",
          "updated_at"
        ],
        "sourceColumns": "account_id,effective_date,balance_yen,updated_by,updated_at"
      },
      {
        "name": "billing_entries",
        "columns": [
          "id",
          "account_id",
          "document_type",
          "entry_date",
          "category",
          "amount_yen",
          "description",
          "note",
          "created_by",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,document_type,entry_date,category,amount_yen,description,note,created_by,created_at,updated_at,deleted_at"
      },
      {
        "name": "billing_settlements",
        "columns": [
          "id",
          "account_id",
          "settlement_date",
          "direction",
          "method",
          "amount_yen",
          "note",
          "created_by",
          "legacy_entry_id",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,settlement_date,direction,method,amount_yen,note,created_by,legacy_entry_id,created_at,updated_at,deleted_at"
      },
      {
        "name": "billing_audit_logs",
        "columns": [
          "id",
          "event_type",
          "actor_account_id",
          "target_account_id",
          "entry_id",
          "attempted_login_id",
          "details_json",
          "occurred_at"
        ],
        "sourceColumns": "id,event_type,actor_account_id,target_account_id,entry_id,attempted_login_id,details_json,occurred_at"
      },
      {
        "name": "password_auth_policy",
        "columns": [
          "service",
          "account_id",
          "password_auth_enabled",
          "password_session_epoch",
          "changed_by",
          "reason",
          "updated_at"
        ],
        "sourceColumns": "service,account_id,password_auth_enabled,password_session_epoch,changed_by,reason,updated_at"
      },
      {
        "name": "password_auth_policy_audit",
        "columns": [
          "id",
          "service",
          "account_id",
          "event_type",
          "password_session_epoch",
          "changed_by",
          "reason",
          "occurred_at"
        ],
        "sourceColumns": "id,service,account_id,event_type,password_session_epoch,changed_by,reason,occurred_at"
      }
    ],
    "knownTables": [
      "billing_accounts",
      "billing_opening_balances",
      "billing_audit_logs",
      "billing_entries",
      "billing_settlements",
      "billing_login_attempts",
      "password_auth_policy",
      "password_auth_policy_audit"
    ]
  },
  "payments": {
    "label": "\u652F\u6255\u660E\u7D30",
    "binding": "PAYMENTS_DB",
    "database": "payments-db",
    "migration": "0002_monthly_ledger.sql",
    "tables": [
      {
        "name": "payments_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version"
        ],
        "sourceColumns": "id,display_name,is_active,session_version"
      },
      {
        "name": "payments_entries",
        "columns": [
          "id",
          "account_id",
          "paid_on",
          "payee",
          "description",
          "amount",
          "start_month",
          "months",
          "notes",
          "version",
          "created_at",
          "updated_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,paid_on,payee,description,amount,start_month,months,notes,version,created_at,updated_at,deleted_at"
      },
      {
        "name": "payments_monthly_marks",
        "columns": [
          "entry_id",
          "target_month",
          "amount",
          "completed_at"
        ],
        "sourceColumns": "entry_id,target_month,amount,completed_at"
      },
      {
        "name": "payments_operation_audit",
        "columns": [
          "request_id",
          "entry_id",
          "target_month",
          "action",
          "occurred_at",
          "identity_id",
          "account_id",
          "entry_version",
          "amount",
          "previous_amount",
          "start_month",
          "previous_start_month",
          "months",
          "previous_months"
        ],
        "sourceColumns": "request_id,entry_id,target_month,action,occurred_at,identity_id,account_id,entry_version,amount,previous_amount,start_month,previous_start_month,months,previous_months"
      },
      {
        "name": "payments_requests",
        "columns": [
          "request_id",
          "fingerprint",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "request_id,fingerprint,response_json,created_at"
      }
    ],
    "knownTables": [
      "payments_accounts",
      "payments_entries",
      "payments_requests",
      "payments_monthly_marks",
      "payments_operation_audit"
    ]
  },
  "health": {
    "label": "\u4F53\u8ABF\u7BA1\u7406",
    "binding": "HEALTH_DB",
    "database": "health-db",
    "migration": "0001_init.sql",
    "tables": [
      {
        "name": "health_records",
        "columns": [
          "record_id",
          "account_id",
          "iv",
          "ciphertext",
          "revision",
          "updated_at"
        ],
        "sourceColumns": "record_id,account_id,iv,ciphertext,revision,updated_at"
      }
    ],
    "knownTables": [
      "health_records"
    ]
  },
  "inventory": {
    "label": "\u5728\u5EAB\u7167\u4F1A",
    "binding": "INVENTORY_DB",
    "database": "inventory-db",
    "migration": "0002_item_deletion.sql",
    "tables": [
      {
        "name": "inventory_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version"
        ],
        "sourceColumns": "id,display_name,is_active,session_version"
      },
      {
        "name": "inventory_items",
        "columns": [
          "id",
          "account_id",
          "name",
          "unit",
          "stock",
          "version",
          "created_at",
          "archived_at",
          "deleted_at"
        ],
        "sourceColumns": "id,account_id,name,unit,stock,version,created_at,archived_at,deleted_at"
      },
      {
        "name": "inventory_movements",
        "columns": [
          "id",
          "account_id",
          "item_id",
          "kind",
          "quantity_delta",
          "expected_version",
          "occurred_at",
          "created_at",
          "voided_at"
        ],
        "sourceColumns": "id,account_id,item_id,kind,quantity_delta,expected_version,occurred_at,created_at,voided_at"
      },
      {
        "name": "inventory_requests",
        "columns": [
          "account_id",
          "request_id",
          "fingerprint",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "account_id,request_id,fingerprint,response_json,created_at"
      }
    ],
    "knownTables": [
      "inventory_accounts",
      "inventory_items",
      "inventory_movements",
      "inventory_requests"
    ]
  },
  "ai": {
    "label": "AI Chat",
    "binding": "AI_DB",
    "database": "ai-db",
    "migration": "0003_tlain_brand.sql",
    "tables": [
      {
        "name": "ai_accounts",
        "columns": [
          "identity_id",
          "display_name",
          "role",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,display_name,role,status,created_at,updated_at"
      },
      {
        "name": "ai_characters",
        "columns": [
          "id",
          "display_name",
          "persona_instructions",
          "speaking_style",
          "first_person",
          "user_address",
          "voice_engine",
          "voice_id",
          "live2d_model_id",
          "active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,display_name,persona_instructions,speaking_style,first_person,user_address,voice_engine,voice_id,live2d_model_id,active,created_at,updated_at"
      },
      {
        "name": "ai_character_settings",
        "columns": [
          "identity_id",
          "character_id",
          "memory_namespace",
          "settings_json",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "identity_id,character_id,memory_namespace,settings_json,created_at,updated_at"
      },
      {
        "name": "ai_conversations",
        "columns": [
          "id",
          "identity_id",
          "character_id",
          "title",
          "current_mode",
          "status",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,character_id,title,current_mode,status,created_at,updated_at"
      },
      {
        "name": "ai_messages",
        "columns": [
          "id",
          "conversation_id",
          "identity_id",
          "character_id",
          "role",
          "content",
          "content_format",
          "source_mode",
          "client_message_id",
          "model",
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "audio_input_tokens",
          "audio_output_tokens",
          "created_at"
        ],
        "sourceColumns": "id,conversation_id,identity_id,character_id,role,content,content_format,source_mode,client_message_id,model,input_tokens,cached_input_tokens,output_tokens,audio_input_tokens,audio_output_tokens,created_at"
      },
      {
        "name": "ai_memories",
        "columns": [
          "id",
          "identity_id",
          "character_id",
          "kind",
          "content",
          "source_conversation_id",
          "importance",
          "retrieval_key",
          "active",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "id,identity_id,character_id,kind,content,source_conversation_id,importance,retrieval_key,active,created_at,updated_at"
      },
      {
        "name": "ai_usage_events",
        "columns": [
          "request_id",
          "identity_id",
          "character_id",
          "conversation_id",
          "model",
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "audio_input_tokens",
          "audio_output_tokens",
          "estimated_cost_micros_jpy",
          "usage_period",
          "occurred_at"
        ],
        "sourceColumns": "request_id,identity_id,character_id,conversation_id,model,input_tokens,cached_input_tokens,output_tokens,audio_input_tokens,audio_output_tokens,estimated_cost_micros_jpy,usage_period,occurred_at"
      },
      {
        "name": "ai_budget_guards",
        "columns": [
          "identity_id",
          "usage_period",
          "spent_micros_jpy",
          "reserved_micros_jpy",
          "updated_at"
        ],
        "sourceColumns": "identity_id,usage_period,spent_micros_jpy,reserved_micros_jpy,updated_at"
      },
      {
        "name": "ai_request_claims",
        "columns": [
          "client_request_id",
          "identity_id",
          "conversation_id",
          "character_id",
          "status",
          "model",
          "reserved_micros_jpy",
          "user_message_id",
          "assistant_message_id",
          "attempt_count",
          "error_code",
          "created_at",
          "updated_at"
        ],
        "sourceColumns": "client_request_id,identity_id,conversation_id,character_id,status,model,reserved_micros_jpy,user_message_id,assistant_message_id,attempt_count,error_code,created_at,updated_at"
      }
    ],
    "knownTables": [
      "ai_accounts",
      "ai_characters",
      "ai_character_settings",
      "ai_conversations",
      "ai_messages",
      "ai_memories",
      "ai_usage_events",
      "ai_budget_guards",
      "ai_request_claims"
    ]
  },
  "downloader": {
    "label": "Downloader\u5229\u7528\u96C6\u8A08",
    "binding": "DOWNLOADER_DB",
    "database": "downloader-db",
    "migration": "0005_downloader_analysis_cancel.sql",
    "tables": [
      {
        "name": "downloader_usage_daily",
        "columns": [
          "day_jst",
          "identity_id",
          "metric",
          "dimension",
          "event_count",
          "byte_count",
          "value_sum",
          "value_max",
          "updated_at"
        ],
        "sourceColumns": "day_jst,identity_id,metric,dimension,event_count,byte_count,value_sum,value_max,updated_at"
      }
    ],
    "knownTables": [
      "downloader_rate_events",
      "downloader_usage_daily",
      "downloader_jobs",
      "downloader_file_delivery_attempts"
    ]
  },
  "calendar": {
    "label": "\u30AB\u30EC\u30F3\u30C0\u30FC",
    "binding": "CALENDAR_DB",
    "database": "calendar-db",
    "migration": "0001_calendar.sql",
    "tables": [
      {
        "name": "calendar_accounts",
        "columns": [
          "id",
          "display_name",
          "is_active",
          "session_version",
          "created_at"
        ],
        "sourceColumns": "id,display_name,is_active,session_version,created_at"
      },
      {
        "name": "calendar_clock",
        "columns": [
          "id",
          "value"
        ],
        "sourceColumns": "id,value"
      },
      {
        "name": "calendar_entities",
        "columns": [
          "account_id",
          "owner_identity",
          "kind",
          "id",
          "payload",
          "version",
          "purged",
          "updated_seq",
          "updated_at"
        ],
        "sourceColumns": "account_id,owner_identity,kind,id,payload,version,purged,updated_seq,updated_at"
      },
      {
        "name": "calendar_requests",
        "columns": [
          "account_id",
          "owner_identity",
          "request_id",
          "payload_hash",
          "kind",
          "entity_id",
          "response_json",
          "created_at"
        ],
        "sourceColumns": "account_id,owner_identity,request_id,payload_hash,kind,entity_id,response_json,created_at"
      }
    ],
    "knownTables": [
      "calendar_accounts",
      "calendar_clock",
      "calendar_entities",
      "calendar_requests"
    ]
  }
};
function archiveSpec(service, migration) {
  const spec = SERVICES[service];
  if (service === "cloud" && migration === "0012_favorites.sql") {
    const legacyColumn = (column) => column !== "trash_operation_id" && column !== "purge_id";
    const legacyTable = (name) => !name.startsWith("cloud_trash_");
    const tables2 = spec.tables.filter((table3) => legacyTable(table3.name)).map((table3) => ({
      ...table3,
      columns: table3.columns.filter(legacyColumn),
      sourceColumns: table3.sourceColumns.split(",").filter(legacyColumn).join(",")
    }));
    return { ...spec, migration, tables: tables2, knownTables: spec.knownTables.filter(legacyTable) };
  }
  if (service !== "household" || migration !== "0006_independent_households.sql") return spec;
  const tables = spec.tables.filter((t) => !t.name.startsWith("household_crypto_")).map((t) => t.name === "household_datasets" ? { ...t, columns: t.columns.filter((c) => c !== "crypto_version"), sourceColumns: t.sourceColumns.replace(",crypto_version", "") } : t);
  return { ...spec, migration, tables, knownTables: tables.map((t) => t.name) };
}

// backup-worker/src/snapshot.js
var SNAPSHOT_DATA_BYTES = 8 * 1024 * 1024;
var SNAPSHOT_JSON_BYTES = 16 * 1024 * 1024;
var ROW_BYTES = 1024 * 1024;

// diary-worker/src/photo-backup.js
var PHOTO_REVERIFY_MS = 30 * 864e5;

// backup-worker/src/billing-encrypted.js
var BILLING_ENCRYPTED_MIGRATION = "billing-encryption-v1";
var SECURITY_BILLING_MIGRATION = "security-diary-billing-keys-v1";
function table2(name, sourceColumns, columns = sourceColumns.split(",")) {
  return { name, sourceColumns, columns };
}
var BILLING_ENCRYPTED_TABLES = [
  table2("billing_encryption_migration", "id,generation,started_at,audit_through_id,writer_public_key,activated_at,verified_checkpoint"),
  table2("billing_encryption_candidate_ledgers", "generation,ledger_id,account_id,recovery_wrapped_key,revision,digest,signature,record_count,staged_count,staged_bytes"),
  table2("billing_encryption_candidate_records", "generation,ledger_id,id,revision,iv,ciphertext"),
  table2("billing_encryption_grants", "generation,ledger_id,identity_id,credential_id,service_link_id,key_source,wrapped_key"),
  table2("billing_encryption_live_ledgers", "generation,ledger_id,revision,digest,signature,writer_public_key,records_json"),
  table2("billing_encryption_operations", "generation,id,actor_id,fingerprint,expected_revisions")
];
var SECURITY_BILLING_VAULTS = table2(
  "security_billing_vaults",
  "credential_id,identity_id,recipient_public_key,recipient_iv,recipient_ciphertext,writer_public_key,writer_iv,writer_ciphertext"
);
function billingEncryptedSpec(spec) {
  const protectedTables = /* @__PURE__ */ new Set(["billing_entries", "billing_opening_balances", "billing_settlements"]);
  const metadata = spec.tables.filter((item) => !protectedTables.has(item.name)).map((item) => item.name === "billing_audit_logs" ? { ...item, columns: item.columns.filter((column) => column !== "details_json" && column !== "entry_id") } : item);
  return { ...spec, migration: BILLING_ENCRYPTED_MIGRATION, tables: [...metadata, ...BILLING_ENCRYPTED_TABLES] };
}

// backup-worker/src/schema-guard.js
var EXPECTED = {
  "portfolio": "0f996aabee4cfcdec8a1ee2f5d5429b170727d19eba88351ec82577bdedc939a",
  "household": "2f7780c5512b5b1fbd610fc9860e4417832050d941773542871189032bfca10f",
  "cloud": "c52cc385ebd2c565f946207ddf36ec9d5a15659b96dacf84039c3023713e1b1d",
  "security": "597cec608e96b2eb5e7704d8e3216a12aaab1ab5279c8355c0291899dad3313e",
  "billing": "e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f",
  "payments": "a74f9ffcabf4a59f3ae58f552de94adc14738883ea1f07baf670c9c6fc3c740f",
  "health": "5d74bfd7ac54779545e86f1e0bd948b29ce3f578c68c309e445f1542d47f98ac",
  "inventory": "ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3",
  "ai": "d7e265eac65afddd4301e02adb081123c3ab7d1d0444f427cf8cec3d57b9ca0c",
  "downloader": "b367e88bee856222f72cfdf97a35794d381a13a3a7126c07ab50a3c43e6fe6a9",
  "calendar": "cdae4a460294b4cefb9b9392b5ea2214fc335124315ad420ccf9644b88611d4c",
  "diary": "6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70"
};
var REVIEWED = {
  billing: ["e3d7d3288312675f4635221c89d6dde4a9a5cdccd4d53848feaa308b1b7c725f", "0caa9787a64446caa2e5062638713c9d9978f884d2e0215dc9c7802a152af42e"],
  inventory: ["ed4811be91f73a7a58cdf29e0c6aade079b4f74529e9042b82399fa8aa13e6f3", "d583deb887f1a14e802b50a550dca0e54e41dfeb5fadeca9a2cc6c9f3bbe10bd"],
  // Reviewed Diary DDL plus additive migration 0022 (not a new production audit).
  diary: ["6b8f6ae0973caf134513739e7f30efdf7a2dd5f0886a1ec4f85cb725f34cfb70", "ac391629ad0de78bd2ac2390429c5021722528ae129a27f1043dfef5b2de014e"]
};
function reviewedSchemaMatches(service, baseline, actual) {
  return typeof baseline === "string" && (actual === baseline || REVIEWED[service]?.[0] === baseline && REVIEWED[service][1] === actual);
}
async function assertSchema(service, rows2) {
  const extension = service === "billing" ? (name) => /^billing_(encryption|candidate|freeze)_/.test(name) : service === "security" ? (name) => name === "security_billing_vaults" : () => false;
  const extra = rows2.filter((row) => extension(row.name));
  if (extra.length) {
    const expected = service === "billing" ? "78f4defbcb4a6662c28ca926de959be22d33da90f9a416f4bb832e5d23e7a7a2" : "b0d6dd06625913b84b28ee5dd371c170ddddee5a84121cc98276a2bfc8cbade4";
    const shape = extra.map((r) => [r.type, r.name, r.tbl_name, r.sql.replace(/\r\n?/g, "\n")]);
    if (await digest(new TextEncoder().encode(JSON.stringify(shape))) !== expected) throw new Error("SchemaReviewRequired");
    rows2 = rows2.filter((row) => !extension(row.name));
  }
  const schema = rows2.filter((r) => r.tbl_name !== "d1_migrations").map((r) => [r.type, r.name, r.tbl_name, r.sql.replace(/\r\n?/g, "\n")]);
  if (!reviewedSchemaMatches(service, EXPECTED[service], await digest(new TextEncoder().encode(JSON.stringify(schema))))) throw new Error("SchemaReviewRequired");
}
var ENCRYPTED_FRAGMENTS = { diary: "609160b000a7bfe17c02101a3e18fc941890bc46058edadc3256d064c2ee639c", security: "fba11d54f4e7ffbabff26541b688517007da622dbf4c3c75fed5c05b6802247e" };
async function assertEncryptedSchema(service, rows2) {
  const encrypted = (row) => service === "diary" ? row.name.startsWith("diary_e2ee_") || row.name.startsWith("diary_plaintext_") : service === "security" && row.name.startsWith("security_diary_key_");
  const fragment = rows2.filter(encrypted).map((r) => [r.type, r.name, r.tbl_name, r.sql.replace(/\r\n?/g, "\n")]);
  if (!ENCRYPTED_FRAGMENTS[service] || await digest(new TextEncoder().encode(JSON.stringify(fragment))) !== ENCRYPTED_FRAGMENTS[service]) throw new Error("SchemaReviewRequired");
  await assertSchema(service, rows2.filter((row) => !encrypted(row)));
}
async function assertArchiveSchema(service, migration, rows2) {
  if (service === "billing" && migration === BILLING_ENCRYPTED_MIGRATION) {
    if (!rows2.some((row) => row.name === "billing_encryption_live_ledgers")) throw new Error("SchemaReviewRequired");
    return assertSchema(service, rows2);
  }
  if (service === "security" && migration === SECURITY_BILLING_MIGRATION) {
    if (!rows2.some((row) => row.name === "security_billing_vaults")) throw new Error("SchemaReviewRequired");
    return rows2.some((row) => row.name === "security_diary_key_config") ? assertEncryptedSchema(service, rows2) : assertSchema(service, rows2);
  }
  if (service === "diary" && (migration === "diary-e2ee-v1" || migration === "0022_photo_backup_identity.sql" && rows2.some((row) => row.name === "diary_e2ee_control")) || service === "security" && migration === "security-diary-keys-v1") return assertEncryptedSchema(service, rows2);
  const historical = service === "cloud" && migration === "0012_favorites.sql" ? "c319c54132d640262b215ffdac570407df82f54e07a1f2395ea3b68291a7625c" : service === "household" && migration === "0006_independent_households.sql" ? "87c3caeb5b1bd4363759e93de4fe377f03064dc96e226fc531546a16146a2ede" : null;
  if (historical) {
    const schema = rows2.filter((r) => r.tbl_name !== "d1_migrations").map((r) => [r.type, r.name, r.tbl_name, r.sql.replace(/\r\n?/g, "\n")]);
    if (await digest(new TextEncoder().encode(JSON.stringify(schema))) !== historical) throw new Error("SchemaReviewRequired");
    return;
  }
  return assertSchema(service, rows2);
}

// diary-worker/src/backup.js
var JST_OFFSET_MS = 9 * 60 * 60 * 1e3;
var BACKUP_TABLES = [
  {
    name: "diary_entries",
    columns: [
      "id",
      "entry_date",
      "last_published_at",
      "entry_time",
      "title",
      "content",
      "created_at",
      "updated_at",
      "deleted_at",
      "revision",
      "author_id",
      "author_name",
      "deleted_by_id",
      "deleted_by_name",
      "household_id",
      "content_format",
      "status",
      "draft_of_entry_id",
      "draft_of_revision",
      "draft_excluded_photo_ids",
      "client_request_id",
      "client_request_hash",
      "last_mutation_id",
      "weather"
    ],
    orderBy: "id ASC"
  },
  {
    name: "diary_tags",
    columns: ["entry_id", "tag", "created_at", "sort_order"],
    orderBy: "entry_id ASC, sort_order ASC"
  },
  {
    name: "diary_photos",
    columns: [
      "id",
      "entry_id",
      "file_name",
      "content_type",
      "original_size",
      "original_key",
      "display_key",
      "thumbnail_key",
      "width",
      "height",
      "created_by_id",
      "created_by_name",
      "created_at",
      "backup_identity"
    ],
    orderBy: "entry_id ASC, created_at ASC, id ASC"
  },
  {
    name: "diary_trash_scopes",
    columns: [
      "id",
      "entry_id",
      "owner_account_id",
      "household_id",
      "scope_type",
      "entry_revision",
      "deleted_by_id",
      "deleted_at",
      "created_at"
    ],
    orderBy: "id ASC"
  },
  {
    name: "diary_favorites",
    columns: ["account_id", "entry_id", "created_at"],
    orderBy: "account_id ASC, entry_id ASC"
  },
  {
    name: "diary_accounts",
    columns: [
      "id",
      "household_id",
      "display_name",
      "role",
      "can_manage_entries",
      "can_view_trash",
      "can_permanently_delete",
      "can_view_investment",
      "active",
      "created_at",
      "updated_at"
    ],
    orderBy: "id ASC"
  },
  {
    name: "investment_history",
    columns: [
      "recorded_at",
      "total",
      "cash",
      "stocks",
      "funds",
      "bonds",
      "crypto",
      "futures",
      "points",
      "other",
      "updated_at"
    ],
    orderBy: "recorded_at ASC"
  }
];
var RESTORE_TABLE_ORDER = Object.freeze([
  "diary_accounts",
  "diary_entries",
  "diary_tags",
  "diary_photos",
  "diary_trash_scopes",
  "diary_favorites",
  "investment_history"
]);

// backup-worker/src/export-sql.js
var MAX_STATEMENT = 16 * 1024 * 1024;

// backup-worker/src/export-backup.js
var FORMAT = "troom-d1-export-v3";
var PART_BYTES = 1024 * 1024;
var MAX_PARTS = 2e4;
function exportSpec(service, migration) {
  if (service === "billing" && migration === BILLING_ENCRYPTED_MIGRATION) return billingEncryptedSpec(SERVICES.billing);
  if (service === "security" && migration === SECURITY_BILLING_MIGRATION) return {
    ...SERVICES.security,
    migration,
    tables: [...SERVICES.security.tables, ...SECURITY_DIARY_TABLES, SECURITY_BILLING_VAULTS]
  };
  if (service === "diary" && migration === DIARY_ENCRYPTED_MIGRATION) return { database: "diary-db", binding: "DIARY_DB", migration, tables: [...BACKUP_TABLES.filter((t) => t.name === "diary_accounts").map((t) => ({ ...t, sourceColumns: t.columns.join(",") })), ...ENCRYPTED_DIARY_TABLES] };
  if (service === "security" && migration === SECURITY_DIARY_MIGRATION) return { ...SERVICES.security, migration, tables: [...SERVICES.security.tables, ...SECURITY_DIARY_TABLES] };
  if (service === "diary") return {
    database: "diary-db",
    binding: "DIARY_DB",
    migration: "0022_photo_backup_identity.sql",
    tables: BACKUP_TABLES.map((t) => ({ ...t, sourceColumns: t.columns.join(",") }))
  };
  if (!Object.hasOwn(SERVICES, service)) throw new Error("SourceUnavailable");
  return service === "cloud" ? archiveSpec(service, migration) : SERVICES[service];
}
var exportPrefix = (service, migration) => service === "diary" ? migration === DIARY_ENCRYPTED_MIGRATION ? "v10/" : "v9/" : migration === SECURITY_BILLING_MIGRATION ? "d1/security/v5/" : migration === BILLING_ENCRYPTED_MIGRATION ? "d1/billing/v4/" : service === "security" && migration === SECURITY_DIARY_MIGRATION ? "d1/security/v4/" : `d1/${service}/v3/`;
function validateExportManifest(manifest, service) {
  const spec = service === "household" ? archiveSpec(service, manifest?.expectedMigration) : exportSpec(service, manifest?.expectedMigration), prefix = exportPrefix(service, manifest?.expectedMigration);
  if (manifest?.format !== FORMAT || manifest.service !== service || manifest.database !== spec.database || manifest.expectedMigration !== spec.migration || manifest.consistency !== "single-database-export" || !Number.isFinite(Date.parse(manifest.scheduledFor)) || !Number.isFinite(Date.parse(manifest.createdAt)) || !Number.isFinite(Date.parse(manifest.completedAt)) || typeof manifest.bookmark !== "string" || !manifest.bookmark || manifest.bookmark.length > 256 || !Array.isArray(manifest.schema) || !Array.isArray(manifest.parts) || manifest.parts.length > MAX_PARTS || Object.keys(manifest.tables || {}).sort().join(",") !== spec.tables.map((t) => t.name).sort().join(",")) throw new Error("SnapshotInvalid");
  if (spec.migration === DIARY_ENCRYPTED_MIGRATION && (!manifest.keyMetadata?.directory || !manifest.keyMetadata?.anchor || !manifest.keyMetadata?.recoveryEnvelope)) throw new Error("SnapshotInvalid");
  const counts = Object.fromEntries(spec.tables.map((t) => [t.name, 0]));
  const keys = /* @__PURE__ */ new Set();
  let bytes = 0;
  for (const part of manifest.parts) {
    if (!part || !part.key?.startsWith(prefix + "data/") || !new RegExp(`^${prefix}data/[a-f0-9-]{36}/[0-9]{6}\\.json\\.gz$`).test(part.key) || keys.has(part.key) || !Object.hasOwn(counts, part.table) || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 16 * 1024 * 1024 || !Number.isSafeInteger(part.rowCount) || part.rowCount <= 0) throw new Error("SnapshotInvalid");
    keys.add(part.key);
    counts[part.table] += part.rowCount;
    bytes += part.bytes;
  }
  for (const t of spec.tables) {
    const stored = manifest.tables[t.name];
    if (JSON.stringify(stored.columns) !== JSON.stringify(t.columns) || stored.rowCount !== counts[t.name]) throw new Error("SnapshotInvalid");
  }
  if (manifest.bytes !== bytes || manifest.rowCount !== Object.values(counts).reduce((a, b) => a + b, 0)) throw new Error("SnapshotInvalid");
}
async function* readExportParts(bucket, manifest, service) {
  validateExportManifest(manifest, service);
  for (const part of manifest.parts) {
    const verified = await verifiedGeneration(bucket, part.key, (p) => {
      if (p?.table !== part.table || !Array.isArray(p.rows) || p.rows.length !== part.rowCount) throw new Error("VerificationFailed");
      const columns = manifest.tables[part.table].columns;
      if (p.rows.some((row) => !row || Object.keys(row).sort().join(",") !== [...columns].sort().join(",") || Object.values(row).some((v) => v !== null && typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v) || Number.isInteger(v) && !Number.isSafeInteger(v))))) throw new Error("SnapshotInvalid");
    });
    if (!verified || verified.sha256 !== part.sha256 || verified.bytes.length !== part.bytes) throw new Error("VerificationFailed");
    yield verified.payload;
  }
}

// security-worker/diary-restore.mjs
var rows = (db, sql) => {
  const statement = db.prepare(sql), result = [];
  try {
    while (statement.step()) result.push(statement.getAsObject());
    return result;
  } finally {
    statement.free();
  }
};
async function restoreDiaryCheckpoint({ bucket, key, trust, onProgress = () => {
}, wasmUrl = "/security/vendor/sql-wasm.wasm" }) {
  const verified = await verifiedGeneration(bucket, key, (p) => validateExportManifest(p, "diary"));
  if (!verified || verified.payload.expectedMigration !== "diary-e2ee-v1") throw new Error("EncryptedCheckpointRequired");
  const manifest = verified.payload;
  await assertArchiveSchema("diary", manifest.expectedMigration, manifest.schema);
  const directory = await verifyDirectory(manifest.keyMetadata.directory, trust.anchor, trust.minimumGeneration);
  await validateKeyMetadata(manifest.keyMetadata, directory, trust.anchor);
  const SQL = await (0, import_sql.default)({ locateFile: () => wasmUrl }), db = new SQL.Database();
  try {
    db.exec(ddl_default);
    const triggers = rows(db, "SELECT name,sql FROM sqlite_schema WHERE type='trigger'");
    const tables = exportSpec("diary", "diary-e2ee-v1").tables;
    db.exec("BEGIN; PRAGMA defer_foreign_keys=ON;");
    for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
    for (const table3 of [...tables].reverse()) db.exec(`DELETE FROM ${table3.name}`);
    const counts = /* @__PURE__ */ new Map();
    let total = 0, bytes = 0;
    for await (const part of readExportParts(bucket, manifest, "diary")) {
      const table3 = tables.find((table4) => table4.name === part.table), columns = [...table3.columns, ...table3.name === "diary_accounts" ? ["login_id"] : []];
      const insert = db.prepare(`INSERT INTO ${table3.name} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")}) RETURNING ${table3.columns.join(",")}`);
      try {
        for (const row of part.rows) {
          await verifyEncryptedDiaryRow(part.table, row, directory);
          bytes += encode(row).length;
          if (bytes > 1e8) throw new Error("RestoreBudgetExceeded");
          insert.bind([...table3.columns.map((column) => row[column]), ...table3.name === "diary_accounts" ? [`restored-${row.id}@invalid.local`] : []]);
          if (!insert.step()) throw new Error("RestoreMismatch");
          const actual = insert.getAsObject();
          if (table3.columns.some((column) => actual[column] !== row[column])) throw new Error("RestoreMismatch");
          insert.reset();
          counts.set(table3.name, (counts.get(table3.name) || 0) + 1);
          total++;
        }
      } finally {
        insert.free();
      }
      onProgress({ phase: "restoring", completed: total, total: manifest.rowCount });
    }
    for (const table3 of tables) if ((counts.get(table3.name) || 0) !== manifest.tables[table3.name].rowCount || rows(db, `SELECT count(*) n FROM ${table3.name}`)[0].n !== manifest.tables[table3.name].rowCount) throw new Error("RestoreRowCountMismatch");
    db.exec("UPDATE diary_accounts SET active=0,session_version=session_version+1,must_change_password=1; UPDATE diary_e2ee_control SET phase='paused',ever_encrypted=1;");
    for (const trigger of triggers) db.exec(trigger.sql);
    if (rows(db, "PRAGMA integrity_check")[0].integrity_check !== "ok" || rows(db, "PRAGMA foreign_key_check").length) throw new Error("RestoreIntegrityFailed");
    db.exec("COMMIT");
    return {
      protocol: "T-lain diary isolated restore",
      version: 1,
      archiveSha256: verified.sha256,
      directoryGeneration: directory.generation,
      sequence: rows(db, "SELECT COALESCE(MAX(seq),0) sequence FROM diary_e2ee_changes")[0].sequence,
      records: rows(db, "SELECT * FROM diary_e2ee_records ORDER BY id").map(parseRecord),
      media: rows(db, "SELECT * FROM diary_e2ee_media ORDER BY id")
    };
  } finally {
    db.close();
  }
}
export {
  restoreDiaryCheckpoint
};
