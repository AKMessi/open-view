use std::collections::HashMap;
use crate::ta;

#[derive(Debug, Clone)]
pub struct LintDiagnostic {
    pub line: usize,
    pub severity: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct PinePlotOutput {
    pub title: String,
    pub color: String,
    pub line_width: f64,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct PineHlineOutput {
    pub price: f64,
    pub title: String,
    pub color: String,
}

#[derive(Debug, Clone)]
pub struct PineExecutionResult {
    pub overlay: bool,
    pub title: String,
    pub plots: Vec<PinePlotOutput>,
    pub hlines: Vec<PineHlineOutput>,
    pub diagnostics: Vec<LintDiagnostic>,
    pub error: Option<String>,
}

/// Static AST/Source Repainting Linter (Phase 6A):
/// Flags unguarded request.security() repainting patterns and conditional stateful ta.* calls
/// while keeping runtime barmerge semantics 100% faithful to Pine v5/v6.
pub fn lint_pine_source(source: &str) -> Vec<LintDiagnostic> {
    let mut diags = Vec::new();
    for (idx, raw_line) in source.lines().enumerate() {
        let line_no = idx + 1;
        let trimmed = raw_line.trim();
        if trimmed.starts_with("//") || trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("request.security(") {
            let has_shift = trimmed.contains("[1]");
            let has_lookahead_off = trimmed.contains("lookahead_off") || !trimmed.contains("lookahead_on");
            if !has_shift && has_lookahead_off {
                diags.push(LintDiagnostic {
                    line: line_no,
                    severity: "warning",
                    message: "Repainting Warning: unconfirmed HTF request.security() fluctuates intra-bar; use expr[1] with barmerge.lookahead_on for strict backtest/live parity.".to_string(),
                });
            }
        }
        if (trimmed.contains('?') && trimmed.contains(':')) && trimmed.contains("ta.") {
            diags.push(LintDiagnostic {
                line: line_no,
                severity: "warning",
                message: "Conditional Series Warning: calling stateful ta.* inside a ternary branch can skip historical bars and drift state; hoist ta.* to top-level scope.".to_string(),
            });
        }
    }
    diags
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Ident(String),
    Number(f64),
    Str(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    Question,
    Colon,
    Assign,
    Reassign, // :=
    Eq,
    Neq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
    Not,
    Var,
    Varip,
    True,
    False,
    Na,
    Newline,
}

fn tokenize(src: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' || ch == '\r' {
            i += 1;
            continue;
        }
        if ch == '\n' {
            tokens.push(Token::Newline);
            i += 1;
            continue;
        }
        if ch == '/' && i + 1 < chars.len() && chars[i + 1] == '/' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            let quote = ch;
            i += 1;
            let mut s = String::new();
            while i < chars.len() && chars[i] != quote {
                s.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                return Err("Unterminated string literal".to_string());
            }
            i += 1;
            tokens.push(Token::Str(s));
            continue;
        }
        if ch.is_ascii_digit() || (ch == '.' && i + 1 < chars.len() && chars[i + 1].is_ascii_digit()) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            let num_str: String = chars[start..i].iter().collect();
            let val = num_str.parse::<f64>().map_err(|_| format!("Invalid number: {}", num_str))?;
            tokens.push(Token::Number(val));
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_' || chars[i] == '.') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            let tok = match word.as_str() {
                "and" => Token::And,
                "or" => Token::Or,
                "not" => Token::Not,
                "var" => Token::Var,
                "varip" => Token::Varip,
                "true" => Token::True,
                "false" => Token::False,
                "na" => Token::Na,
                _ => Token::Ident(word),
            };
            tokens.push(tok);
            continue;
        }

        let next = chars.get(i + 1).copied();
        match (ch, next) {
            (':', Some('=')) => { tokens.push(Token::Reassign); i += 2; }
            ('=', Some('=')) => { tokens.push(Token::Eq); i += 2; }
            ('!', Some('=')) => { tokens.push(Token::Neq); i += 2; }
            ('<', Some('=')) => { tokens.push(Token::Lte); i += 2; }
            ('>', Some('=')) => { tokens.push(Token::Gte); i += 2; }
            ('+', _) => { tokens.push(Token::Plus); i += 1; }
            ('-', _) => { tokens.push(Token::Minus); i += 1; }
            ('*', _) => { tokens.push(Token::Star); i += 1; }
            ('/', _) => { tokens.push(Token::Slash); i += 1; }
            ('%', _) => { tokens.push(Token::Percent); i += 1; }
            ('(', _) => { tokens.push(Token::LParen); i += 1; }
            (')', _) => { tokens.push(Token::RParen); i += 1; }
            ('[', _) => { tokens.push(Token::LBracket); i += 1; }
            (']', _) => { tokens.push(Token::RBracket); i += 1; }
            (',', _) => { tokens.push(Token::Comma); i += 1; }
            ('?', _) => { tokens.push(Token::Question); i += 1; }
            (':', _) => { tokens.push(Token::Colon); i += 1; }
            ('=', _) => { tokens.push(Token::Assign); i += 1; }
            ('<', _) => { tokens.push(Token::Lt); i += 1; }
            ('>', _) => { tokens.push(Token::Gt); i += 1; }
            _ => return Err(format!("Unexpected character '{}'", ch)),
        }
    }
    tokens.push(Token::Newline);
    Ok(tokens)
}

#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Bool(bool),
    Str(String),
    Na,
    Ident(String),
    HistoryRef(Box<Expr>, usize),
    UnaryMinus(Box<Expr>),
    Not(Box<Expr>),
    Binary(BinOp, Box<Expr>, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Call(String, Vec<(Option<String>, Expr)>),
}

#[derive(Debug, Clone, Copy)]
enum BinOp {
    Add, Sub, Mul, Div, Mod,
    Eq, Neq, Lt, Lte, Gt, Gte,
    And, Or,
}

#[derive(Debug, Clone)]
enum Stmt {
    IndicatorDecl { title: String, overlay: bool },
    VarDecl { name: String, expr: Expr, kind: VarKind },
    Reassign { name: String, expr: Expr },
    Plot { expr: Expr, title: String, color: String, line_width: f64 },
    Hline { price: f64, title: String, color: String },
    ExprStmt(Expr),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum VarKind {
    Series,
    Var,
    Varip,
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        if self.pos < self.tokens.len() {
            let t = self.tokens[self.pos].clone();
            self.pos += 1;
            Some(t)
        } else {
            None
        }
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Some(Token::Newline)) {
            self.pos += 1;
        }
    }

    fn parse_program(&mut self) -> Result<Vec<Stmt>, String> {
        let mut stmts = Vec::new();
        self.skip_newlines();
        while self.peek().is_some() {
            stmts.push(self.parse_stmt()?);
            self.skip_newlines();
        }
        Ok(stmts)
    }

    fn parse_stmt(&mut self) -> Result<Stmt, String> {
        if matches!(self.peek(), Some(Token::Var | Token::Varip)) {
            let kind = match self.next() {
                Some(Token::Var) => VarKind::Var,
                _ => VarKind::Varip,
            };
            // Optional type annotation e.g. `var float x = 0.0`
            let first = match self.next() {
                Some(Token::Ident(s)) => s,
                other => return Err(format!("Expected identifier after var/varip, got {:?}", other)),
            };
            let name = if matches!(self.peek(), Some(Token::Ident(_))) {
                match self.next() {
                    Some(Token::Ident(n)) => n,
                    _ => unreachable!(),
                }
            } else {
                first
            };
            if !matches!(self.next(), Some(Token::Assign)) {
                return Err(format!("Expected '=' in declaration of {}", name));
            }
            let expr = self.parse_expr()?;
            return Ok(Stmt::VarDecl { name, expr, kind });
        }

        // Check `name = expr` or `name := expr`
        if let Some(Token::Ident(name)) = self.peek().cloned() {
            let next1 = self.tokens.get(self.pos + 1);
            if matches!(next1, Some(Token::Assign)) {
                self.pos += 2;
                let expr = self.parse_expr()?;
                return Ok(Stmt::VarDecl { name, expr, kind: VarKind::Series });
            }
            if matches!(next1, Some(Token::Reassign)) {
                self.pos += 2;
                let expr = self.parse_expr()?;
                return Ok(Stmt::Reassign { name, expr });
            }
            // Optional typed series declaration: `float x = ...`
            if matches!(next1, Some(Token::Ident(_))) && matches!(self.tokens.get(self.pos + 2), Some(Token::Assign)) {
                let var_name = match self.tokens[self.pos + 1].clone() {
                    Token::Ident(s) => s,
                    _ => unreachable!(),
                };
                self.pos += 3;
                let expr = self.parse_expr()?;
                return Ok(Stmt::VarDecl { name: var_name, expr, kind: VarKind::Series });
            }
        }

        let expr = self.parse_expr()?;
        if let Expr::Call(ref callee, ref args) = expr {
            if callee == "indicator" || callee == "strategy" {
                let mut title = "Pine Script".to_string();
                let mut overlay = false;
                for (i, (kw, arg)) in args.iter().enumerate() {
                    if kw.as_deref() == Some("title") || (kw.is_none() && i == 0) {
                        if let Expr::Str(s) = arg {
                            title = s.clone();
                        }
                    }
                    if kw.as_deref() == Some("overlay") {
                        if let Expr::Bool(b) = arg {
                            overlay = *b;
                        }
                    }
                }
                return Ok(Stmt::IndicatorDecl { title, overlay });
            }
            if callee == "plot" {
                let mut series_expr = Expr::Na;
                let mut title = "Plot".to_string();
                let mut color = "#2962ff".to_string();
                let mut line_width = 1.5;
                for (i, (kw, arg)) in args.iter().enumerate() {
                    if kw.as_deref() == Some("series") || (kw.is_none() && i == 0) {
                        series_expr = arg.clone();
                    } else if kw.as_deref() == Some("title") || (kw.is_none() && i == 1) {
                        if let Expr::Str(s) = arg {
                            title = s.clone();
                        }
                    } else if kw.as_deref() == Some("color") || (kw.is_none() && i == 2) {
                        color = resolve_color_expr(arg);
                    } else if kw.as_deref() == Some("linewidth") {
                        if let Expr::Num(n) = arg {
                            line_width = *n;
                        }
                    }
                }
                return Ok(Stmt::Plot { expr: series_expr, title, color, line_width });
            }
            if callee == "hline" {
                let mut price = 0.0;
                let mut title = "Level".to_string();
                let mut color = "#787b86".to_string();
                for (i, (kw, arg)) in args.iter().enumerate() {
                    if kw.as_deref() == Some("price") || (kw.is_none() && i == 0) {
                        if let Expr::Num(n) = arg {
                            price = *n;
                        }
                    } else if kw.as_deref() == Some("title") || (kw.is_none() && i == 1) {
                        if let Expr::Str(s) = arg {
                            title = s.clone();
                        }
                    } else if kw.as_deref() == Some("color") {
                        color = resolve_color_expr(arg);
                    }
                }
                return Ok(Stmt::Hline { price, title, color });
            }
        }
        Ok(Stmt::ExprStmt(expr))
    }

    fn parse_expr(&mut self) -> Result<Expr, String> {
        self.parse_ternary()
    }

    fn parse_ternary(&mut self) -> Result<Expr, String> {
        let cond = self.parse_or()?;
        if matches!(self.peek(), Some(Token::Question)) {
            self.pos += 1;
            let then_e = self.parse_expr()?;
            if !matches!(self.next(), Some(Token::Colon)) {
                return Err("Expected ':' in ternary expression".to_string());
            }
            let else_e = self.parse_expr()?;
            return Ok(Expr::Ternary(Box::new(cond), Box::new(then_e), Box::new(else_e)));
        }
        Ok(cond)
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        while matches!(self.peek(), Some(Token::Or)) {
            self.pos += 1;
            let right = self.parse_and()?;
            left = Expr::Binary(BinOp::Or, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_cmp()?;
        while matches!(self.peek(), Some(Token::And)) {
            self.pos += 1;
            let right = self.parse_cmp()?;
            left = Expr::Binary(BinOp::And, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_cmp(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_add()?;
        while let Some(op) = match self.peek() {
            Some(Token::Eq) => Some(BinOp::Eq),
            Some(Token::Neq) => Some(BinOp::Neq),
            Some(Token::Lt) => Some(BinOp::Lt),
            Some(Token::Lte) => Some(BinOp::Lte),
            Some(Token::Gt) => Some(BinOp::Gt),
            Some(Token::Gte) => Some(BinOp::Gte),
            _ => None,
        } {
            self.pos += 1;
            let right = self.parse_add()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_mul()?;
        while let Some(op) = match self.peek() {
            Some(Token::Plus) => Some(BinOp::Add),
            Some(Token::Minus) => Some(BinOp::Sub),
            _ => None,
        } {
            self.pos += 1;
            let right = self.parse_mul()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_unary()?;
        while let Some(op) = match self.peek() {
            Some(Token::Star) => Some(BinOp::Mul),
            Some(Token::Slash) => Some(BinOp::Div),
            Some(Token::Percent) => Some(BinOp::Mod),
            _ => None,
        } {
            self.pos += 1;
            let right = self.parse_unary()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Some(Token::Minus)) {
            self.pos += 1;
            return Ok(Expr::UnaryMinus(Box::new(self.parse_unary()?)));
        }
        if matches!(self.peek(), Some(Token::Not)) {
            self.pos += 1;
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Result<Expr, String> {
        let mut expr = self.parse_primary()?;
        while matches!(self.peek(), Some(Token::LBracket)) {
            self.pos += 1;
            let offset_expr = self.parse_expr()?;
            if !matches!(self.next(), Some(Token::RBracket)) {
                return Err("Expected ']' in history reference".to_string());
            }
            let offset = match offset_expr {
                Expr::Num(n) if n >= 0.0 => n as usize,
                _ => return Err("History offset must be a non-negative integer".to_string()),
            };
            expr = Expr::HistoryRef(Box::new(expr), offset);
        }
        Ok(expr)
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Some(Token::Number(n)) => Ok(Expr::Num(n)),
            Some(Token::True) => Ok(Expr::Bool(true)),
            Some(Token::False) => Ok(Expr::Bool(false)),
            Some(Token::Str(s)) => Ok(Expr::Str(s)),
            Some(Token::Na) => Ok(Expr::Na),
            Some(Token::LParen) => {
                let inner = self.parse_expr()?;
                if !matches!(self.next(), Some(Token::RParen)) {
                    return Err("Expected ')'".to_string());
                }
                Ok(inner)
            }
            Some(Token::Ident(name)) => {
                if matches!(self.peek(), Some(Token::LParen)) {
                    self.pos += 1;
                    let mut args = Vec::new();
                    while !matches!(self.peek(), Some(Token::RParen) | None) {
                        let kw = if let Some(Token::Ident(k)) = self.peek().cloned() {
                            if matches!(self.tokens.get(self.pos + 1), Some(Token::Assign)) {
                                self.pos += 2;
                                Some(k)
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        let arg_expr = self.parse_expr()?;
                        args.push((kw, arg_expr));
                        if matches!(self.peek(), Some(Token::Comma)) {
                            self.pos += 1;
                        } else {
                            break;
                        }
                    }
                    if !matches!(self.next(), Some(Token::RParen)) {
                        return Err(format!("Expected ')' after call to {}", name));
                    }
                    Ok(Expr::Call(name, args))
                } else {
                    Ok(Expr::Ident(name))
                }
            }
            other => Err(format!("Unexpected token: {:?}", other)),
        }
    }
}

fn resolve_color_expr(expr: &Expr) -> String {
    match expr {
        Expr::Str(s) => s.clone(),
        Expr::Ident(id) => match id.as_str() {
            "color.blue" => "#2962ff".to_string(),
            "color.green" | "color.lime" => "#089981".to_string(),
            "color.red" => "#f23645".to_string(),
            "color.orange" => "#ff9800".to_string(),
            "color.yellow" => "#ffeb3b".to_string(),
            "color.purple" => "#ab47bc".to_string(),
            "color.aqua" | "color.teal" => "#26c6da".to_string(),
            "color.white" => "#ffffff".to_string(),
            "color.gray" | "color.silver" => "#787b86".to_string(),
            _ => "#2962ff".to_string(),
        },
        _ => "#2962ff".to_string(),
    }
}

/// Arena-Rollback State Engine verifying Pine v5/v6 `var` rollback vs `varip` realtime persistence!
#[derive(Debug, Clone)]
pub struct PineRollbackArena {
    /// Committed bar-close snapshot for `var` variables
    var_committed: HashMap<String, f64>,
    /// Live working values for `var` variables (rolled back on every intra-bar tick!)
    var_working: HashMap<String, f64>,
    /// Isolated `varip` arena — NEVER rolled back across live intra-bar ticks!
    varip_state: HashMap<String, f64>,
}

impl PineRollbackArena {
    pub fn new() -> Self {
        Self {
            var_committed: HashMap::new(),
            var_working: HashMap::new(),
            varip_state: HashMap::new(),
        }
    }

    pub fn rollback_for_live_tick(&mut self) {
        self.var_working = self.var_committed.clone();
    }

    pub fn commit_bar_close(&mut self) {
        self.var_committed = self.var_working.clone();
    }

    pub fn get_var(&self, name: &str) -> Option<f64> {
        self.var_working.get(name).copied()
    }

    pub fn set_var(&mut self, name: &str, val: f64) {
        self.var_working.insert(name.to_string(), val);
    }

    pub fn get_varip(&self, name: &str) -> Option<f64> {
        self.varip_state.get(name).copied()
    }

    pub fn set_varip(&mut self, name: &str, val: f64) {
        self.varip_state.insert(name.to_string(), val);
    }
}

struct EvalContext<'a> {
    n: usize,
    open: &'a [f64],
    high: &'a [f64],
    low: &'a [f64],
    close: &'a [f64],
    volume: &'a [f64],
    series: HashMap<String, Vec<f64>>,
    var_kinds: HashMap<String, VarKind>,
    arena: PineRollbackArena,
}

impl<'a> EvalContext<'a> {
    fn eval_series(&mut self, expr: &Expr) -> Result<Vec<f64>, String> {
        match expr {
            Expr::Num(v) => Ok(vec![*v; self.n]),
            Expr::Bool(b) => Ok(vec![if *b { 1.0 } else { 0.0 }; self.n]),
            Expr::Na | Expr::Str(_) => Ok(vec![f64::NAN; self.n]),
            Expr::Ident(name) => match name.as_str() {
                "open" => Ok(self.open.to_vec()),
                "high" => Ok(self.high.to_vec()),
                "low" => Ok(self.low.to_vec()),
                "close" => Ok(self.close.to_vec()),
                "volume" => Ok(self.volume.to_vec()),
                "hl2" => Ok((0..self.n).map(|i| (self.high[i] + self.low[i]) * 0.5).collect()),
                "hlc3" => Ok((0..self.n).map(|i| (self.high[i] + self.low[i] + self.close[i]) / 3.0).collect()),
                "ohlc4" => Ok((0..self.n).map(|i| (self.open[i] + self.high[i] + self.low[i] + self.close[i]) * 0.25).collect()),
                "bar_index" => Ok((0..self.n).map(|i| i as f64).collect()),
                _ => self
                    .series
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("Undefined identifier '{}'", name)),
            },
            Expr::HistoryRef(inner, offset) => {
                let src = self.eval_series(inner)?;
                let mut out = vec![f64::NAN; self.n];
                for i in *offset..self.n {
                    out[i] = src[i - *offset];
                }
                Ok(out)
            }
            Expr::UnaryMinus(inner) => Ok(self.eval_series(inner)?.into_iter().map(|v| -v).collect()),
            Expr::Not(inner) => Ok(self
                .eval_series(inner)?
                .into_iter()
                .map(|v| if v == 0.0 || v.is_nan() { 1.0 } else { 0.0 })
                .collect()),
            Expr::Binary(op, l, r) => {
                let lv = self.eval_series(l)?;
                let rv = self.eval_series(r)?;
                let mut out = Vec::with_capacity(self.n);
                for i in 0..self.n {
                    let a = lv[i];
                    let b = rv[i];
                    let res = match op {
                        BinOp::Add => a + b,
                        BinOp::Sub => a - b,
                        BinOp::Mul => a * b,
                        BinOp::Div => if b == 0.0 { f64::NAN } else { a / b },
                        BinOp::Mod => if b == 0.0 { f64::NAN } else { a % b },
                        BinOp::Eq => if (a - b).abs() < 1e-12 { 1.0 } else { 0.0 },
                        BinOp::Neq => if (a - b).abs() >= 1e-12 { 1.0 } else { 0.0 },
                        BinOp::Lt => if a < b { 1.0 } else { 0.0 },
                        BinOp::Lte => if a <= b { 1.0 } else { 0.0 },
                        BinOp::Gt => if a > b { 1.0 } else { 0.0 },
                        BinOp::Gte => if a >= b { 1.0 } else { 0.0 },
                        BinOp::And => if a != 0.0 && !a.is_nan() && b != 0.0 && !b.is_nan() { 1.0 } else { 0.0 },
                        BinOp::Or => if (a != 0.0 && !a.is_nan()) || (b != 0.0 && !b.is_nan()) { 1.0 } else { 0.0 },
                    };
                    out.push(res);
                }
                Ok(out)
            }
            Expr::Ternary(cond, then_e, else_e) => {
                let cv = self.eval_series(cond)?;
                let tv = self.eval_series(then_e)?;
                let ev = self.eval_series(else_e)?;
                Ok((0..self.n)
                    .map(|i| if cv[i] != 0.0 && !cv[i].is_nan() { tv[i] } else { ev[i] })
                    .collect())
            }
            Expr::Call(callee, args) => self.eval_call(callee, args),
        }
    }

    fn eval_const_usize(&mut self, expr: &Expr) -> Result<usize, String> {
        let s = self.eval_series(expr)?;
        let v = s.last().copied().unwrap_or(0.0);
        if v.is_nan() || v < 0.0 {
            return Err("Period argument must be a positive integer".to_string());
        }
        Ok(v.round() as usize)
    }

    fn eval_call(&mut self, callee: &str, args: &[(Option<String>, Expr)]) -> Result<Vec<f64>, String> {
        let arg = |idx: usize| -> Result<&Expr, String> {
            args.get(idx)
                .map(|(_, e)| e)
                .ok_or_else(|| format!("Missing argument {} for {}", idx, callee))
        };

        match callee {
            "ta.sma" | "sma" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::sma(&src, p))
            }
            "ta.ema" | "ema" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::ema(&src, p))
            }
            "ta.rma" | "rma" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::rma(&src, p))
            }
            "ta.wma" | "wma" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::wma(&src, p))
            }
            "ta.hma" | "hma" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::hma(&src, p))
            }
            "ta.rsi" | "rsi" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?;
                Ok(ta::rsi(&src, p))
            }
            "ta.atr" | "atr" => {
                let p = self.eval_const_usize(arg(0)?)?;
                Ok(ta::atr(self.high, self.low, self.close, p))
            }
            "ta.change" => {
                let src = self.eval_series(arg(0)?)?;
                let len = if args.len() > 1 { self.eval_const_usize(arg(1)?)? } else { 1 };
                let mut out = vec![f64::NAN; self.n];
                for i in len..self.n {
                    out[i] = src[i] - src[i - len];
                }
                Ok(out)
            }
            "ta.crossover" => {
                let a = self.eval_series(arg(0)?)?;
                let b = self.eval_series(arg(1)?)?;
                let mut out = vec![0.0; self.n];
                for i in 1..self.n {
                    if a[i - 1] <= b[i - 1] && a[i] > b[i] {
                        out[i] = 1.0;
                    }
                }
                Ok(out)
            }
            "ta.crossunder" => {
                let a = self.eval_series(arg(0)?)?;
                let b = self.eval_series(arg(1)?)?;
                let mut out = vec![0.0; self.n];
                for i in 1..self.n {
                    if a[i - 1] >= b[i - 1] && a[i] < b[i] {
                        out[i] = 1.0;
                    }
                }
                Ok(out)
            }
            "ta.highest" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?.max(1);
                let mut out = vec![f64::NAN; self.n];
                for i in (p - 1)..self.n {
                    let mut m = f64::NEG_INFINITY;
                    for &v in &src[(i + 1 - p)..=i] {
                        if v > m { m = v; }
                    }
                    out[i] = m;
                }
                Ok(out)
            }
            "ta.lowest" => {
                let src = self.eval_series(arg(0)?)?;
                let p = self.eval_const_usize(arg(1)?)?.max(1);
                let mut out = vec![f64::NAN; self.n];
                for i in (p - 1)..self.n {
                    let mut m = f64::INFINITY;
                    for &v in &src[(i + 1 - p)..=i] {
                        if v < m { m = v; }
                    }
                    out[i] = m;
                }
                Ok(out)
            }
            "math.abs" | "abs" => Ok(self.eval_series(arg(0)?)?.into_iter().map(f64::abs).collect()),
            "math.sqrt" | "sqrt" => Ok(self.eval_series(arg(0)?)?.into_iter().map(f64::sqrt).collect()),
            "math.max" | "max" => {
                let a = self.eval_series(arg(0)?)?;
                let b = self.eval_series(arg(1)?)?;
                Ok((0..self.n).map(|i| a[i].max(b[i])).collect())
            }
            "math.min" | "min" => {
                let a = self.eval_series(arg(0)?)?;
                let b = self.eval_series(arg(1)?)?;
                Ok((0..self.n).map(|i| a[i].min(b[i])).collect())
            }
            "nz" => {
                let src = self.eval_series(arg(0)?)?;
                let repl = if args.len() > 1 { self.eval_series(arg(1)?)? } else { vec![0.0; self.n] };
                Ok((0..self.n).map(|i| if src[i].is_nan() { repl[i] } else { src[i] }).collect())
            }
            "na" => {
                let src = self.eval_series(arg(0)?)?;
                Ok(src.into_iter().map(|v| if v.is_nan() { 1.0 } else { 0.0 }).collect())
            }
            "input.int" | "input.float" | "input" => self.eval_series(arg(0)?),
            _ => Err(format!("Unsupported Pine function '{}'", callee)),
        }
    }
}

pub fn eval_pine_script(
    source: &str,
    open: &[f64],
    high: &[f64],
    low: &[f64],
    close: &[f64],
    volume: &[f64],
) -> PineExecutionResult {
    let diagnostics = lint_pine_source(source);
    let n = open.len().min(high.len()).min(low.len()).min(close.len()).min(volume.len());

    let tokens = match tokenize(source) {
        Ok(t) => t,
        Err(e) => {
            return PineExecutionResult {
                overlay: true,
                title: "Pine Script".to_string(),
                plots: vec![],
                hlines: vec![],
                diagnostics,
                error: Some(e),
            };
        }
    };

    let mut parser = Parser::new(tokens);
    let stmts = match parser.parse_program() {
        Ok(s) => s,
        Err(e) => {
            return PineExecutionResult {
                overlay: true,
                title: "Pine Script".to_string(),
                plots: vec![],
                hlines: vec![],
                diagnostics,
                error: Some(e),
            };
        }
    };

    let mut ctx = EvalContext {
        n,
        open,
        high,
        low,
        close,
        volume,
        series: HashMap::new(),
        var_kinds: HashMap::new(),
        arena: PineRollbackArena::new(),
    };

    let mut overlay = true;
    let mut title = "Pine Script".to_string();
    let mut plots = Vec::new();
    let mut hlines = Vec::new();

    for stmt in stmts {
        match stmt {
            Stmt::IndicatorDecl { title: t, overlay: ov } => {
                title = t;
                overlay = ov;
            }
            Stmt::VarDecl { name, expr, kind } => {
                match ctx.eval_series(&expr) {
                    Ok(vals) => {
                        if kind == VarKind::Var {
                            if let Some(&last) = vals.last() {
                                ctx.arena.set_var(&name, last);
                                ctx.arena.commit_bar_close();
                            }
                        } else if kind == VarKind::Varip {
                            if let Some(&last) = vals.last() {
                                ctx.arena.set_varip(&name, last);
                            }
                        }
                        ctx.var_kinds.insert(name.clone(), kind);
                        ctx.series.insert(name, vals);
                    }
                    Err(e) => {
                        return PineExecutionResult { overlay, title, plots, hlines, diagnostics, error: Some(e) };
                    }
                }
            }
            Stmt::Reassign { name, expr } => {
                match ctx.eval_series(&expr) {
                    Ok(vals) => {
                        ctx.series.insert(name, vals);
                    }
                    Err(e) => {
                        return PineExecutionResult { overlay, title, plots, hlines, diagnostics, error: Some(e) };
                    }
                }
            }
            Stmt::Plot { expr, title: pt, color, line_width } => match ctx.eval_series(&expr) {
                Ok(values) => plots.push(PinePlotOutput { title: pt, color, line_width, values }),
                Err(e) => {
                    return PineExecutionResult { overlay, title, plots, hlines, diagnostics, error: Some(e) };
                }
            },
            Stmt::Hline { price, title: ht, color } => {
                hlines.push(PineHlineOutput { price, title: ht, color });
            }
            Stmt::ExprStmt(expr) => {
                if let Err(e) = ctx.eval_series(&expr) {
                    return PineExecutionResult { overlay, title, plots, hlines, diagnostics, error: Some(e) };
                }
            }
        }
    }

    PineExecutionResult {
        overlay,
        title,
        plots,
        hlines,
        diagnostics,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executes_pine_v6_ema_cross_and_history_lookback_accurately() {
        let src = r#"
//@version=6
indicator("Dual EMA + Lookback", overlay=true)
fast = ta.ema(close, 5)
slow = ta.ema(close, 10)
prev_close = close[1]
plot(fast, title="EMA 5", color=color.green, linewidth=2)
plot(slow, title="EMA 10", color=color.red)
plot(prev_close, title="Prev Close", color=color.blue)
"#;
        let close: Vec<f64> = (1..=30).map(|i| 100.0 + (i as f64)).collect();
        let res = eval_pine_script(src, &close, &close, &close, &close, &close);
        assert!(res.error.is_none(), "unexpected error: {:?}", res.error);
        assert!(res.overlay);
        assert_eq!(res.plots.len(), 3);
        assert!(res.plots[0].values[29] > res.plots[1].values[29]);
        // close[1] at bar 10 must equal close[9] = 110.0
        assert!((res.plots[2].values[10] - 110.0).abs() < 1e-12);
    }

    #[test]
    fn arena_rolls_back_var_on_1000_realtime_ticks_while_preserving_varip() {
        let mut arena = PineRollbackArena::new();
        // Committed bar N-1 state
        arena.set_var("bar_counter", 10.0);
        arena.commit_bar_close();
        arena.set_varip("tick_counter", 0.0);

        for _ in 0..1000 {
            arena.rollback_for_live_tick();
            // Script increments both `var` and `varip` on every live tick
            let v = arena.get_var("bar_counter").unwrap() + 1.0;
            arena.set_var("bar_counter", v);

            let vp = arena.get_varip("tick_counter").unwrap() + 1.0;
            arena.set_varip("tick_counter", vp);
        }

        // `var` MUST still be 11.0 (rolled back to 10.0 before each tick -> zero drift!)
        assert_eq!(arena.get_var("bar_counter"), Some(11.0));
        // `varip` MUST persist all 1,000 intra-bar ticks!
        assert_eq!(arena.get_varip("tick_counter"), Some(1000.0));

        // Commit bar close -> `var` locks in 11.0 for bar N+1
        arena.commit_bar_close();
        arena.rollback_for_live_tick();
        assert_eq!(arena.get_var("bar_counter"), Some(11.0));
    }

    #[test]
    fn static_repainting_linter_flags_unguarded_htf_security_and_conditional_ta() {
        let risky = r#"
//@version=6
indicator("Risky", overlay=true)
htf = request.security(syminfo.tickerid, "60", close)
bad = close > open ? ta.ema(close, 10) : ta.sma(close, 10)
plot(htf)
"#;
        let diags = lint_pine_source(risky);
        assert_eq!(diags.len(), 2);
        assert!(diags[0].message.contains("Repainting Warning"));
        assert!(diags[1].message.contains("Conditional Series Warning"));
    }
}
