use super::types::*;
use serde_json::json;
pub fn definitions() -> Vec<BenchmarkDraft> {
    let common=BenchmarkDraft{schema_version:1,name:"Structured extraction".into(),description:"Extract an objective, small structured answer.".into(),category:"reasoning".into(),task_family:"generic-structured-extraction".into(),split:"development".into(),prompt:"From 'Mira has 3 red blocks and 2 blue blocks', return only JSON with keys name and total.".into(),source:"Distill generic fixture".into(),license:"CC0-1.0".into(),execution_profile:"native_text".into(),measurement_profile:"task_metrics".into(),evaluator:Evaluator{kind:"json".into(),expected:"{\"name\":\"Mira\",\"total\":5}".into(),rubric:String::new(),revision:"1".into(),known_good:"{\"name\":\"Mira\",\"total\":5}".into(),known_bad:"{\"name\":\"Mira\",\"total\":6}".into()},permissions:Permissions{tools:vec![],network:false,context:"clean".into()},limits:Limits{timeout_seconds:120,max_turns:1,max_artifact_bytes:1024*1024},repetitions:1,fixtures:vec![],environment:json!({"track":"native_agent","context":"clean","cachePolicy":"provider_default"}),work_class_id:default_work_class(),role_id:None,facets:TaskFacets::default(),role_prompt:String::new(),role_context_hash:default_context_hash(),entry_state:None,workflow:None};
    let mut transform = common.clone();
    transform.name = "Deterministic transformation".into();
    transform.task_family = "generic-sort-deduplicate".into();
    transform.prompt="Sort these integers ascending and remove duplicates: 9, 2, 5, 2, -1. Return only a JSON array.".into();
    transform.evaluator.expected = "[-1,2,5,9]".into();
    transform.evaluator.known_good = "[-1,2,5,9]".into();
    transform.evaluator.known_bad = "[2,5,9]".into();
    let mut code = common.clone();
    code.name = "Repair inclusive range sum".into();
    code.category = "code".into();
    code.task_family = "generic-range-sum".into();
    code.execution_profile = "protected_repository".into();
    code.prompt="Repair this JavaScript function to sum every integer from a to b inclusive, returning zero when a > b: function sumRange(a,b){let s=0;for(let i=a;i<b;i++)s+=i;return s;} Return only the function source, without Markdown.".into();
    code.evaluator.kind = "javascript".into();
    code.evaluator.expected = include_str!("../../../resources/benchmarks/range-sum-checks.json")
        .trim()
        .into();
    code.evaluator.known_good =
        "function sumRange(a,b){let s=0;for(let i=a;i<=b;i++)s+=i;return s;}".into();
    code.evaluator.known_bad = "function sumRange(a,b){return 0;}".into();
    let mut ui = common.clone();
    ui.name = "Accessible greeting form".into();
    ui.category = "frontend".into();
    ui.task_family = "generic-greeting-form".into();
    ui.execution_profile = "isolated_ui".into();
    ui.prompt="Return only a complete standalone HTML document. Build an accessible form with a labeled input id=name, a button id=submit, and an output id=result. Clicking submit displays Hello, <name>! in the output without navigating. Use no external resources.".into();
    ui.evaluator.kind = "browser".into();
    ui.evaluator.expected = include_str!("../../../resources/benchmarks/greeting-form-checks.json")
        .trim()
        .into();
    ui.evaluator.known_good="<!doctype html><label for=name>Name</label><input id=name><button id=submit type=button>Greet</button><output id=result></output><script>document.querySelector('#submit').onclick=()=>{document.querySelector('#result').textContent='Hello, '+document.querySelector('#name').value+'!';};</script>".into();
    ui.evaluator.known_bad =
        "<!doctype html><input id=name><button id=submit>Greet</button><output id=result></output>"
            .into();
    transform.work_class_id = "general-medium".into();
    code.work_class_id = "coding-simple".into();
    code.facets.language = Some("javascript".into());
    code.facets.difficulty = Some("easy".into());
    ui.work_class_id = "frontend-ui".into();
    ui.facets.language = Some("html".into());
    ui.environment["visualRubric"] = json!("visual-v1: legible labels, visible focus, clear output and consistent spacing; scored separately from functional checks");
    let mut ui_repair = ui.clone();
    ui_repair.name = "Repair counter interaction".into();
    ui_repair.task_family = "generic-counter-interaction".into();
    ui_repair.prompt = "Repair this standalone counter interface: <button id=increment>Increment</button><output id=count>0</output>. Return a complete accessible HTML document whose button increments the visible count by one on each click without navigating. Use no external resources.".into();
    ui_repair.evaluator.expected = json!({"steps":[{"action":"click","selector":"#increment"},{"action":"click","selector":"#increment"},{"action":"expectText","selector":"#count","value":"2"}]}).to_string();
    ui_repair.evaluator.known_good = "<!doctype html><button id=increment type=button>Increment</button><output id=count aria-live=polite>0</output><script>let n=0;document.querySelector('#increment').onclick=()=>document.querySelector('#count').textContent=String(++n);</script>".into();
    ui_repair.evaluator.known_bad =
        "<!doctype html><button id=increment>Increment</button><output id=count>0</output>".into();
    let mut clamp = code.clone();
    clamp.name = "Repair bounded clamp".into();
    clamp.task_family = "generic-clamp-boundary".into();
    clamp.prompt = "Repair this JavaScript function so it clamps x to inclusive [lo, hi]: function clamp(x,lo,hi){return Math.max(hi,Math.min(lo,x));} Return only function source without Markdown.".into();
    clamp.evaluator.expected = json!({"functionName":"clamp","argsCases":[{"args":[-5,0,10],"expected":0},{"args":[4,0,10],"expected":4},{"args":[20,0,10],"expected":10}]}).to_string();
    clamp.evaluator.known_good =
        "function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}".into();
    clamp.evaluator.known_bad = "function clamp(x,lo,hi){return hi;}".into();
    let mut repository = code.clone();
    repository.name = "Diagnose and repair invoice modules".into();
    repository.task_family = "generic-invoice-module-contract".into();
    repository.work_class_id = "coding-complex".into();
    repository.facets.difficulty = Some("hard".into());
    repository.prompt = "Repair the integration between the frozen pricing and invoice modules. Return a single JavaScript function invoice(items) that applies each item's integer quantity to its priceCents, applies a fixed ten-percent discount to the subtotal, then rounds once to nearest whole cent. Return zero for an empty list. No Markdown.".into();
    repository.fixtures = vec![Fixture { path:"pricing.js".into(), content:"export const subtotal=items=>items.reduce((s,i)=>s+i.priceCents,0);".into() },Fixture {path:"invoice.js".into(),content:"import {subtotal} from './pricing.js'; export const invoice=(items,discountPercent=10)=>Math.round(subtotal(items))*(100-discountPercent)/100; // Contract fixes discount at ten percent for this artifact.".into()}];
    repository.evaluator.expected = json!({"functionName":"invoice","argsCases":[{"args":[[]],"expected":0},{"args":[[{"priceCents":101,"quantity":3}]],"expected":273},{"args":[[{"priceCents":50,"quantity":2},{"priceCents":21,"quantity":1}]],"expected":109}]}).to_string();
    repository.evaluator.known_good = "function invoice(items){return Math.round(items.reduce((s,i)=>s+i.priceCents*i.quantity,0)*0.9);}".into();
    repository.evaluator.known_bad = "function invoice(items){return items.length;}".into();
    repository.workflow = Some(WorkflowSpec {schema_version:1,driver_revision:"public-feedback-v1".into(),steps:vec![WorkflowStep{id:"diagnose".into(),prompt:"Inspect the public modules and describe the quantity and rounding defects. Do not invent test results.".into(),include_previous_output:false},WorkflowStep{id:"repair".into(),prompt:repository.prompt.clone(),include_previous_output:true}]});
    let mut graph = code.clone();
    graph.name = "Repair transitive dependency traversal".into();
    graph.task_family = "generic-transitive-dependencies".into();
    graph.work_class_id = "coding-complex".into();
    graph.facets.difficulty = Some("hard".into());
    graph.prompt = "Implement function dependencies(graph,start) in JavaScript. graph maps names to direct dependencies. Return every transitively reachable dependency once, sorted lexicographically, excluding start even for cycles. Treat missing names as leaves. Return only the function source.".into();
    graph.evaluator.expected = json!({"functionName":"dependencies","argsCases":[{"args":[{"a":["b"],"b":["c"],"c":["a"]},"a"],"expected":["b","c"]},{"args":[{"a":["b","c"],"b":["d"],"c":["d"]},"a"],"expected":["b","c","d"]},{"args":[{},"x"],"expected":[]}]}).to_string();
    graph.evaluator.known_good = "function dependencies(graph,start){const seen=new Set([start]);function walk(n){for(const d of graph[n]||[]){if(!seen.has(d)){seen.add(d);walk(d);}}}walk(start);seen.delete(start);return [...seen].sort();}".into();
    graph.evaluator.known_bad =
        "function dependencies(graph,start){return graph[start]||[];}".into();
    let objective =
        |class: &str, family: &str, name: &str, prompt: &str, expected: serde_json::Value| {
            let mut d = common.clone();
            d.work_class_id = class.into();
            d.task_family = family.into();
            d.name = name.into();
            d.prompt = prompt.into();
            d.evaluator.expected = expected.to_string();
            d.evaluator.known_good = expected.to_string();
            d.evaluator.known_bad = "null".into();
            d
        };
    let mut sources = objective("one-shot","generic-source-pack-extraction","Extract facts from a frozen source pack","Using only the public source pack, return JSON {\"launchYear\":number,\"maintainer\":string}. Resolve claims by the dated correction.",json!({"launchYear":2022,"maintainer":"Lena"}));
    sources.fixtures=vec![Fixture{path:"sources.txt".into(),content:"2023 overview: Project Alder launched in 2021; maintainer Lena. 2024 correction: launch year was 2022; all other overview details unchanged.".into()}];
    let mut crosscheck=objective("one-shot","generic-source-pack-crosscheck","Cross-check two frozen reports","Use only public reports. Return JSON with confirmedCities sorted alphabetically; only cities mentioned by both independent reports count.",json!({"confirmedCities":["Oslo","Rome"]}));
    crosscheck.fixtures = vec![Fixture {
        path: "reports.txt".into(),
        content: "Report A: Oslo, Rome, Lima. Report B: Rome, Oslo, Bern.".into(),
    }];
    let mut definitions=vec![common.clone(),transform,code,ui,ui_repair,clamp,repository,graph,sources,crosscheck,
        objective("planning","generic-dependency-order","Order a constrained release plan","Return the unique JSON array order of these tasks: deploy depends on verify; verify depends on build; build depends on spec; spec has no dependencies. Include all tasks once.",json!(["spec","build","verify","deploy"])),
        objective("planning","generic-resource-schedule","Schedule a serial resource","Tasks A, B, C use one worker and take 2, 3, 1 hours. B must follow A; C must follow B. Start at hour zero. Return JSON start hours for A, B, C and finish hour.",json!({"A":0,"B":2,"C":5,"finish":6})),
        objective("testing-heavy","generic-boundary-mutation-checks","Choose checks that distinguish independent defects","A correct predicate accepts integers 1 through 3 inclusive. Mutant L rejects 1; mutant U accepts 4. From candidates 0,1,2,3,4 return the smallest sorted JSON array that detects both mutants.",json!([1,4])),
        objective("testing-heavy","generic-regression-triage","Diagnose a seeded regression","Baseline results: parse pass, cache pass, render pass. After change: parse pass, cache fail, render fail. Dependencies: render uses cache; cache uses parse. Return JSON {root:string,affected:[string,string]} with affected sorted alphabetically and the earliest failed dependency as root.",json!({"root":"cache","affected":["cache","render"]})),
        objective("testing-light","generic-off-by-one-verification","Explain a bounded verification failure","Test expects sum(1,2)=3, implementation loops for i=1; i<2; i++ adding i. Return JSON {actual:number,cause:string}; cause must be exclusive_upper_bound.",json!({"actual":1,"cause":"exclusive_upper_bound"})),
        objective("testing-light","generic-command-result-verification","Read a frozen verification result","Frozen check output: total=4 passed=3 failed=1 exitCode=1. Return JSON {successful:boolean,failed:number,exitCode:number}. Do not claim success when failures remain.",json!({"successful":false,"failed":1,"exitCode":1})),
        objective("general-medium","generic-constrained-choice","Choose a feasible option under constraints","Options: A costs 7 and takes 4 hours; B costs 5 and takes 7 hours; C costs 9 and takes 3 hours. Budget is 8 and deadline 5. Return JSON {option:string,totalCost:number,hours:number} for the feasible option.",json!({"option":"A","totalCost":7,"hours":4})),
        objective("general-light","generic-short-classification","Classify an explicit value","Return only JSON {category:string} for temperature -3 using categories below_zero for negatives, zero for zero, above_zero for positives.",json!({"category":"below_zero"}))];
    for d in &mut definitions {
        d.facets.output_format = Some(
            match d.evaluator.kind.as_str() {
                "browser" => "html",
                "javascript" => "javascript",
                _ => "json",
            }
            .into(),
        );
        if d.facets.difficulty.is_none() {
            d.facets.difficulty = Some("easy".into());
        }
        d.description =
            "Small deterministic pipeline fixture; no empirical model ranking is implied.".into();
        super::routing::normalize_draft(d);
    }
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_work_class_has_two_independent_valid_pipeline_families() {
        let seeds = definitions();
        for class in super::super::routing::WORK_CLASSES {
            let families: std::collections::BTreeSet<_> = seeds
                .iter()
                .filter(|d| d.work_class_id == class)
                .map(|d| &d.task_family)
                .collect();
            assert!(
                families.len() >= 2,
                "missing independent families for {class}"
            );
        }
        for d in seeds {
            assert!(
                super::super::catalog::validate(&d).valid,
                "{}: {:?}",
                d.name,
                super::super::catalog::validate(&d).issues
            );
        }
        let frontend = include_str!("../../../../src/features/agents/lib/modelRanking.ts");
        let union = frontend
            .split("export type ModelPreferenceClassId =")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let declared: std::collections::BTreeSet<_> = union
            .lines()
            .filter_map(|line| line.split('"').nth(1))
            .collect();
        let backend: std::collections::BTreeSet<_> =
            super::super::routing::WORK_CLASSES.into_iter().collect();
        assert_eq!(
            declared, backend,
            "Benchmark work classes must reuse the application class contract"
        );
    }
}
