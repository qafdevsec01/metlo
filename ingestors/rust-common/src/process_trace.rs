use crate::{
    open_api::{find_open_api_diff, get_split_path, EndpointInfo},
    process_graphql::{process_graphql_body, process_graphql_query},
    sensitive_data::detect_sensitive_data,
    trace::{ApiResponse, ApiTrace, GraphQlRes, KeyVal, ProcessTraceRes},
    METLO_CONFIG,
};
use libinjection::{sqli, xss};
use multipart::server::Multipart;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::BufRead,
};

fn is_endpoint_match(trace_tokens: &Vec<&str>, endpoint_path: String) -> bool {
    let endpoint_tokens = get_split_path(&endpoint_path);
    if trace_tokens.len() != endpoint_tokens.len() {
        return false;
    }

    for (i, endpoint_token) in endpoint_tokens.into_iter().enumerate() {
        let trace_token = trace_tokens[i];
        if endpoint_token != trace_token
            && (!endpoint_token.starts_with('{') && !endpoint_token.ends_with('}'))
        {
            return false;
        }
    }
    true
}

fn insert_data_type(data_types: &mut HashMap<String, HashSet<String>>, path: &str, d_type: String) {
    let old_data_types = data_types.get_mut(path);
    match old_data_types {
        None => {
            data_types.insert(path.to_string(), HashSet::from([d_type]));
        }
        Some(old) => {
            old.insert(d_type);
        }
    }
}

fn process_json_val(
    path: &mut String,
    data_types: &mut HashMap<String, HashSet<String>>,
    xss_detected: &mut HashMap<String, String>,
    sqli_detected: &mut HashMap<String, (String, String)>,
    sensitive_data_detected: &mut HashMap<String, HashSet<String>>,
    total_runs: &mut i32,
    v: &Value,
) {
    *total_runs += 1;
    if *total_runs > 500 {
        return;
    }
    match v {
        serde_json::Value::Null => {
            insert_data_type(data_types, path, "null".to_string());
        }
        serde_json::Value::Bool(_) => {
            insert_data_type(data_types, path, "boolean".to_string());
        }
        serde_json::Value::Number(_) => {
            insert_data_type(data_types, path, "number".to_string());
        }
        serde_json::Value::String(e) => {
            insert_data_type(data_types, path, "string".to_string());

            if xss(e).unwrap_or(false) {
                xss_detected.insert(path.clone(), e.to_string());
            }

            let is_sqli = sqli(e).unwrap_or((false, "".to_string()));
            if is_sqli.0 {
                sqli_detected.insert(path.clone(), (e.to_string(), is_sqli.1));
            }

            let sensitive_data = detect_sensitive_data(e.as_str());
            if !sensitive_data.is_empty() {
                let old_sensitive_data = sensitive_data_detected.get_mut(path);
                match old_sensitive_data {
                    None => {
                        sensitive_data_detected.insert(path.to_string(), sensitive_data);
                    }
                    Some(old) => {
                        for e in sensitive_data {
                            old.insert(e);
                        }
                    }
                }
            }
        }
        serde_json::Value::Array(ls) => {
            let old_len = path.len();
            path.push_str(".[]");

            for e in ls {
                process_json_val(
                    path,
                    data_types,
                    xss_detected,
                    sqli_detected,
                    sensitive_data_detected,
                    total_runs,
                    e,
                )
            }

            path.truncate(old_len);
        }
        serde_json::Value::Object(m) => {
            for (k, nested_val) in m.iter() {
                let old_len = path.len();
                path.push('.');
                path.push_str(k);

                process_json_val(
                    path,
                    data_types,
                    xss_detected,
                    sqli_detected,
                    sensitive_data_detected,
                    total_runs,
                    nested_val,
                );

                path.truncate(old_len);
            }
        }
    }
}

fn process_json(
    prefix: String,
    value: Value,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    let mut data_types: HashMap<String, HashSet<String>> = HashMap::new();
    let mut xss_detected: HashMap<String, String> = HashMap::new();
    let mut sqli_detected: HashMap<String, (String, String)> = HashMap::new();
    let mut sensitive_data_detected: HashMap<String, HashSet<String>> = HashMap::new();
    let mut total_runs = 0;

    let mut path = prefix.clone();
    process_json_val(
        &mut path,
        &mut data_types,
        &mut xss_detected,
        &mut sqli_detected,
        &mut sensitive_data_detected,
        &mut total_runs,
        &value,
    );

    Some(ProcessTraceRes {
        block: !(xss_detected.is_empty() && sqli_detected.is_empty()),
        xss_detected: (!xss_detected.is_empty()).then_some(xss_detected),
        sqli_detected: (!sqli_detected.is_empty()).then_some(sqli_detected),
        sensitive_data_detected: (!sensitive_data_detected.is_empty())
            .then_some(sensitive_data_detected),
        data_types: (!data_types.is_empty()).then_some(data_types),
        validation_errors: if prefix.starts_with("resBody") {
            find_open_api_diff(trace, &value, endpoint_info)
        } else {
            None
        },
        request_content_type: "".to_owned(),
        response_content_type: "".to_owned(),
        graph_ql_data: None,
    })
}

fn process_json_string(
    prefix: String,
    body: &str,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    match serde_json::from_str(body) {
        Ok(value) => process_json(prefix, value, trace, endpoint_info),
        Err(_) => {
            log::debug!("Invalid JSON");
            None
        }
    }
}

fn process_form_data(
    prefix: String,
    body: &str,
    mut mime_params: mime::Params,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    let boundary = mime_params.find(|e| e.0 == "boundary");
    if let Some(b) = boundary {
        let mut mp = Multipart::with_body(body.as_bytes(), b.1.as_str());
        let mut form_json = json!({});
        while let Some(mut field) = mp.read_entry().unwrap() {
            let data = field.data.fill_buf().unwrap_or(b"");
            let s = String::from_utf8_lossy(data);
            form_json[field.headers.name.to_string()] = serde_json::Value::String(s.to_string());
        }
        process_json(prefix, form_json, trace, endpoint_info)
    } else {
        None
    }
}

fn process_url_encoded(
    prefix: String,
    body: &str,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    match serde_urlencoded::from_str::<Value>(body) {
        Ok(value) => process_json(prefix, value, trace, endpoint_info),
        Err(_) => {
            log::debug!("Invalid URL Encoded string");
            None
        }
    }
}

fn process_text_plain(
    prefix: String,
    body: &str,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    let is_xss = xss(body).unwrap_or(false);
    let is_sqli = sqli(body).unwrap_or((false, "".to_string()));
    let sensitive_data = detect_sensitive_data(body);

    let mut process_trace_res = ProcessTraceRes {
        block: false,
        xss_detected: None,
        sqli_detected: None,
        sensitive_data_detected: None,
        data_types: Some(HashMap::from([(
            prefix.clone(),
            HashSet::from(["string".to_string()]),
        )])),
        validation_errors: if prefix.starts_with("resBody") {
            find_open_api_diff(trace, &Value::String(body.to_owned()), endpoint_info)
        } else {
            None
        },
        request_content_type: "".to_owned(),
        response_content_type: "".to_owned(),
        graph_ql_data: None,
    };

    if is_xss {
        process_trace_res.block = true;
        process_trace_res.xss_detected = Some(HashMap::from([(prefix.clone(), body.to_string())]))
    }
    if is_sqli.0 {
        process_trace_res.block = true;
        process_trace_res.sqli_detected = Some(HashMap::from([(
            prefix.clone(),
            (body.to_string(), is_sqli.1),
        )]))
    }
    if !sensitive_data.is_empty() {
        process_trace_res.block = true;
        process_trace_res.sensitive_data_detected = Some(HashMap::from([(prefix, sensitive_data)]))
    }

    Some(process_trace_res)
}

fn process_body(
    prefix: String,
    body: &str,
    m: mime::Mime,
    trace: &ApiTrace,
    endpoint_info: EndpointInfo,
) -> Option<ProcessTraceRes> {
    let essence = m.essence_str();
    if essence == mime::APPLICATION_JSON {
        process_json_string(prefix, body, trace, endpoint_info)
    } else if essence == mime::TEXT_PLAIN {
        process_text_plain(prefix, body, trace, endpoint_info)
    } else if essence == mime::MULTIPART_FORM_DATA {
        process_form_data(prefix, body, m.params(), trace, endpoint_info)
    } else if essence == mime::APPLICATION_WWW_FORM_URLENCODED {
        process_url_encoded(prefix, body, trace, endpoint_info)
    } else {
        process_text_plain(prefix, body, trace, endpoint_info)
    }
}

fn process_key_val(prefix: String, vals: &Vec<KeyVal>) -> Option<ProcessTraceRes> {
    let mut data_types: HashMap<String, HashSet<String>> = HashMap::new();
    let mut xss_detected: HashMap<String, String> = HashMap::new();
    let mut sqli_detected: HashMap<String, (String, String)> = HashMap::new();
    let mut sensitive_data_detected: HashMap<String, HashSet<String>> = HashMap::new();

    for e in vals {
        let is_xss = xss(&e.value).unwrap_or(false);
        let is_sqli = sqli(&e.value).unwrap_or((false, "".to_string()));
        let sensitive_data = detect_sensitive_data(&e.value);

        let path = format!("{}.{}", prefix, e.name);
        insert_data_type(&mut data_types, &path, "string".to_string());
        if is_xss {
            xss_detected.insert(path.clone(), e.value.clone());
        }
        if is_sqli.0 {
            sqli_detected.insert(path.clone(), (e.value.clone(), is_sqli.1));
        }
        if !sensitive_data.is_empty() {
            let old_sensitive_data = sensitive_data_detected.get_mut(&path);
            match old_sensitive_data {
                None => {
                    sensitive_data_detected.insert(path, sensitive_data);
                }
                Some(old) => {
                    for e in sensitive_data {
                        old.insert(e);
                    }
                }
            }
        }
    }

    Some(ProcessTraceRes {
        block: !(xss_detected.is_empty() && sqli_detected.is_empty()),
        xss_detected: (!xss_detected.is_empty()).then_some(xss_detected),
        sqli_detected: (!sqli_detected.is_empty()).then_some(sqli_detected),
        sensitive_data_detected: (!sensitive_data_detected.is_empty())
            .then_some(sensitive_data_detected),
        data_types: (!data_types.is_empty()).then_some(data_types),
        validation_errors: None,
        request_content_type: "".to_owned(),
        response_content_type: "".to_owned(),
        graph_ql_data: None,
    })
}

fn get_content_type(headers: &[KeyVal]) -> Option<&String> {
    headers
        .iter()
        .find(|e| e.name.to_lowercase() == "content-type")
        .map(|e| &e.value)
}

fn get_mime_type(content_type_header: Option<&String>) -> mime::Mime {
    content_type_header.map_or(mime::TEXT_PLAIN, |e| e.parse().unwrap_or(mime::TEXT_PLAIN))
}

fn combine_process_trace_res(
    results: &[Option<ProcessTraceRes>],
    request_content_type: Option<&String>,
    response_content_type: Option<&String>,
    proc_graph_ql: Option<GraphQlRes>,
) -> ProcessTraceRes {
    let mut block = false;
    let mut xss_detected: HashMap<String, String> = HashMap::new();
    let mut sqli_detected: HashMap<String, (String, String)> = HashMap::new();
    let mut sensitive_data_detected: HashMap<String, HashSet<String>> = HashMap::new();
    let mut data_types: HashMap<String, HashSet<String>> = HashMap::new();
    let mut validation_errors: HashMap<String, Vec<String>> = HashMap::new();

    for res in results.iter().flatten() {
        block |= res.block;
        if let Some(e_xss) = &res.xss_detected {
            xss_detected.extend(e_xss.clone());
        }
        if let Some(e_sqli) = &res.sqli_detected {
            sqli_detected.extend(e_sqli.clone());
        }
        if let Some(e_sensitive_data) = &res.sensitive_data_detected {
            sensitive_data_detected.extend(e_sensitive_data.clone());
        }
        if let Some(e_data_types) = &res.data_types {
            data_types.extend(e_data_types.clone());
        }
        if let Some(e_validation_errors) = &res.validation_errors {
            validation_errors.extend(e_validation_errors.clone())
        }
    }

    ProcessTraceRes {
        block,
        xss_detected: (!xss_detected.is_empty()).then_some(xss_detected),
        sqli_detected: (!sqli_detected.is_empty()).then_some(sqli_detected),
        sensitive_data_detected: (!sensitive_data_detected.is_empty())
            .then_some(sensitive_data_detected),
        data_types: (!data_types.is_empty()).then_some(data_types),
        validation_errors: (!validation_errors.is_empty()).then_some(validation_errors),
        request_content_type: request_content_type.unwrap_or(&"".to_owned()).to_owned(),
        response_content_type: response_content_type.unwrap_or(&"".to_owned()).to_owned(),
        graph_ql_data: proc_graph_ql,
    }
}

pub fn process_api_trace(trace: &ApiTrace) -> (ProcessTraceRes, bool) {
    let req_content_type = get_content_type(&trace.request.headers);
    let req_mime_type = get_mime_type(req_content_type);
    let non_error_status_code = match &trace.response {
        Some(ApiResponse {
            status,
            headers: _,
            body: _,
        }) => *status < 400,
        _ => false,
    };

    let mut openapi_spec_name: Option<String> = None;
    let mut full_trace_capture_enabled: bool = false;
    let mut is_graph_ql: bool = false;
    let mut endpoint_path: String = trace.request.url.path.clone();
    let split_path: Vec<&str> = get_split_path(&trace.request.url.path);
    let conf_read = METLO_CONFIG.try_read();
    if let Ok(ref conf) = METLO_CONFIG.try_read() {
        if let Some(endpoints) = &conf.endpoints {
            let key = format!(
                "{}-{}",
                trace.request.url.host,
                trace.request.method.to_lowercase()
            );
            if let Some(matched_endpoints) = endpoints.get(&key) {
                for endpoint in matched_endpoints.iter() {
                    if is_endpoint_match(&split_path, endpoint.path.clone()) {
                        openapi_spec_name = endpoint.openapi_spec_name.to_owned();
                        full_trace_capture_enabled = endpoint.full_trace_capture_enabled;
                        endpoint_path = endpoint.path.clone();
                        is_graph_ql = endpoint.is_graph_ql;
                        break;
                    }
                }
            }
        }
    }
    drop(conf_read);

    let proc_req_body = match (
        non_error_status_code,
        !trace.request.body.is_empty(),
        !is_graph_ql,
    ) {
        (true, true, true) => process_body(
            "reqBody".to_string(),
            trace.request.body.as_str(),
            req_mime_type,
            trace,
            EndpointInfo {
                openapi_spec_name: None,
                endpoint_path: "".to_owned(),
            },
        ),
        _ => None,
    };
    let proc_req_params = match (non_error_status_code, !is_graph_ql) {
        (true, true) => process_key_val("reqQuery".to_string(), &trace.request.url.parameters),
        _ => None,
    };
    let proc_req_headers = match non_error_status_code {
        true => process_key_val("reqHeaders".to_string(), &trace.request.headers),
        false => None,
    };
    let proc_graph_ql = match (is_graph_ql, trace.request.method.to_lowercase().as_str()) {
        (true, "post") => process_graphql_body(&trace.request.body),
        (true, "get") => process_graphql_query(&trace.request.url.parameters),
        _ => None,
    };

    let mut proc_resp_headers: Option<ProcessTraceRes> = None;
    let mut resp_content_type: Option<&String> = None;
    let proc_resp_body: Option<ProcessTraceRes> = {
        if let Some(resp) = &trace.response {
            proc_resp_headers = process_key_val("resHeaders".to_string(), &resp.headers);
            resp_content_type = get_content_type(&resp.headers);
            let resp_mime_type = get_mime_type(resp_content_type);
            process_body(
                "resBody".to_string(),
                &resp.body,
                resp_mime_type,
                trace,
                EndpointInfo {
                    openapi_spec_name,
                    endpoint_path,
                },
            )
        } else {
            process_body(
                "resBody".to_string(),
                "",
                mime::TEXT_PLAIN,
                trace,
                EndpointInfo {
                    openapi_spec_name,
                    endpoint_path,
                },
            )
        }
    };

    (
        combine_process_trace_res(
            &[
                proc_req_body,
                proc_req_params,
                proc_req_headers,
                proc_resp_body,
                proc_resp_headers,
            ],
            req_content_type,
            resp_content_type,
            proc_graph_ql,
        ),
        full_trace_capture_enabled,
    )
}
