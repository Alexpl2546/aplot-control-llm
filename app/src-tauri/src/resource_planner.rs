//! Independent advisory planner and in-memory admission ledger. No Tauri, SQL,
//! hardware polling, filesystem access, or process lifecycle side effects.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

const MAX_SAFE: u64 = 9_007_199_254_740_991;
const MIB: f64 = 1_048_576.0;
macro_rules! dto {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name { $(pub $field: $ty),* }
    };
}
dto!(ByteRange { min: u64, max: Option<u64> });
dto!(PoolBudget { total_bytes: Option<u64>, observed_used_bytes: Option<u64>, free_bytes: Option<u64>, limit_bytes: Option<u64>, spare_bytes: u64 });
dto!(HardwareBudget { snapshot_id: String, snapshot_age_ms: u64, max_snapshot_age_ms: u64, ram: PoolBudget, pinned_ram: Option<PoolBudget>, gpus: BTreeMap<String, PoolBudget> });
dto!(ResourceAmounts { ram_bytes: u64, pinned_ram_bytes: u64, gpu_bytes: BTreeMap<String, u64> });
dto!(ResourceClaim {
    claim_id: String,
    owner_id: String,
    generation: u64,
    amounts: ResourceAmounts
});
dto!(ResourceObservation { snapshot_id: String, owner_id: String, generation: u64, ram_bytes: Option<u64>, pinned_ram_bytes: Option<u64>, gpu_bytes: BTreeMap<String, u64> });
dto!(AccountingInput { hardware: HardwareBudget, claims: Vec<ResourceClaim>, observations: Vec<ResourceObservation> });
dto!(AccountedPool { base_free_bytes: Option<u64>, available_bytes: Option<u64>, residual_reserved_bytes: u64, spare_bytes: u64, reasons: Vec<String> });
dto!(ResourceAvailability { ram: AccountedPool, pinned_ram: Option<AccountedPool>, gpus: BTreeMap<String, AccountedPool> });
dto!(KvMetadata {
    layers: u64,
    kv_heads: u64,
    key_head_dim: u64,
    value_head_dim: u64,
    key_bytes_per_element: f64,
    value_bytes_per_element: f64
});
dto!(ModelResourceMetadata { artifact_bytes: Option<u64>, format: String, weights_complete: bool, architecture: String, attention: String, kv: Option<KvMetadata> });
dto!(EngineResourceOptions {
    placement: String, gpu_id: Option<String>, gpu_layers: Option<u64>, kv_on_gpu: bool,
    kv_capacity_tokens: Option<u64>, kv_capacity_scales_with_context: bool, unmodelled_allocations: bool,
    workspace_ram: Option<ByteRange>, workspace_gpu: Option<ByteRange>,
    extra_ram_bytes: u64, pinned_ram_bytes: u64, extra_gpu_bytes: BTreeMap<String, u64>,
    gpu_budget_bytes: BTreeMap<String, u64>, spare_ram_bytes: u64, spare_gpu_bytes: BTreeMap<String, u64>
});
dto!(ResourceRequest {
    engine: String,
    model: ModelResourceMetadata,
    context_tokens: u64,
    minimum_context_tokens: u64,
    options: EngineResourceOptions
});
dto!(ResourcePlannerInput { hardware: HardwareBudget, claims: Vec<ResourceClaim>, observations: Vec<ResourceObservation>, request: ResourceRequest });
dto!(ResourceEstimate { artifact_bytes: Option<u64>, kv: Option<ByteRange>, ram: ByteRange, pinned_ram: ByteRange, gpus: BTreeMap<String, ByteRange>, confidence: String, source: String, reasons: Vec<String> });
dto!(PoolAssessment { pool: String, required: ByteRange, available_bytes: Option<u64>, status: String });
dto!(ResourceCandidate { id: String, placement: String, gpu_layers: Option<u64>, context_tokens: u64, kv_capacity_tokens: Option<u64>, estimate: ResourceEstimate, status: String, assessments: Vec<PoolAssessment> });
dto!(ResourcePlan { contract_version: u32, availability: ResourceAvailability, candidates: Vec<ResourceCandidate>, automatic_application: bool });
dto!(PlannerError {
    code: String,
    message: String
});
impl std::fmt::Display for PlannerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for PlannerError {}
fn error(code: &str, message: &str) -> PlannerError {
    PlannerError {
        code: code.into(),
        message: message.into(),
    }
}
fn invalid(message: &str) -> PlannerError {
    error("invalidInput", message)
}
fn safe(value: u64) -> Result<(), PlannerError> {
    if value > MAX_SAFE {
        Err(invalid("Value exceeds the safe integer contract."))
    } else {
        Ok(())
    }
}
fn positive(value: u64) -> Result<(), PlannerError> {
    safe(value)?;
    if value == 0 {
        Err(invalid("A positive count is required."))
    } else {
        Ok(())
    }
}
fn sum(values: impl IntoIterator<Item = u64>) -> Result<u64, PlannerError> {
    let mut result = 0u64;
    for value in values {
        safe(value)?;
        result = result
            .checked_add(value)
            .ok_or_else(|| invalid("Memory sum overflow."))?;
        safe(result)?;
    }
    Ok(result)
}
fn validate_map(map: &BTreeMap<String, u64>) -> Result<(), PlannerError> {
    for (id, bytes) in map {
        if id.trim().is_empty() || ["ram", "pinnedRam"].contains(&id.as_str()) {
            return Err(invalid("Reserved/empty device ID."));
        }
        safe(*bytes)?;
    }
    Ok(())
}
fn validate_pool(pool: &PoolBudget) -> Result<(), PlannerError> {
    safe(pool.spare_bytes)?;
    for v in [
        pool.total_bytes,
        pool.observed_used_bytes,
        pool.free_bytes,
        pool.limit_bytes,
    ]
    .into_iter()
    .flatten()
    {
        safe(v)?;
    }
    if let Some(total) = pool.total_bytes {
        if pool.observed_used_bytes.unwrap_or(0) > total
            || pool.free_bytes.unwrap_or(0) > total
            || matches!((pool.observed_used_bytes, pool.free_bytes), (Some(used), Some(free)) if used + free > total)
        {
            return Err(invalid("Memory telemetry exceeds totalBytes."));
        }
    }
    Ok(())
}
fn usage(pool: &PoolBudget) -> Option<u64> {
    pool.observed_used_bytes.or_else(|| {
        pool.total_bytes
            .zip(pool.free_bytes)
            .map(|(total, free)| total - free)
    })
}
fn observation_value(o: &ResourceObservation, pool: &str) -> Option<u64> {
    match pool {
        "ram" => o.ram_bytes,
        "pinnedRam" => o.pinned_ram_bytes,
        _ => o.gpu_bytes.get(pool).copied(),
    }
}
fn claim_value(c: &ResourceClaim, pool: &str) -> u64 {
    match pool {
        "ram" => c.amounts.ram_bytes,
        "pinnedRam" => c.amounts.pinned_ram_bytes,
        _ => c.amounts.gpu_bytes.get(pool).copied().unwrap_or(0),
    }
}
fn validate_claim(c: &ResourceClaim) -> Result<(), PlannerError> {
    if c.claim_id.trim().is_empty() || c.owner_id.trim().is_empty() {
        return Err(invalid("Claim identity is required."));
    }
    safe(c.generation)?;
    safe(c.amounts.ram_bytes)?;
    safe(c.amounts.pinned_ram_bytes)?;
    if c.amounts.pinned_ram_bytes > c.amounts.ram_bytes {
        return Err(invalid("Pinned RAM must be included in RAM."));
    }
    validate_map(&c.amounts.gpu_bytes)
}
fn validate_accounting(input: &AccountingInput) -> Result<(), PlannerError> {
    let h = &input.hardware;
    if h.snapshot_id.trim().is_empty() {
        return Err(invalid("snapshotId is required."));
    }
    safe(h.snapshot_age_ms)?;
    safe(h.max_snapshot_age_ms)?;
    validate_pool(&h.ram)?;
    if let Some(pool) = &h.pinned_ram {
        validate_pool(pool)?;
    }
    for (id, pool) in &h.gpus {
        if ["ram", "pinnedRam"].contains(&id.as_str()) || id.trim().is_empty() {
            return Err(invalid("Reserved/empty GPU ID."));
        }
        validate_pool(pool)?;
    }
    let mut ids = BTreeSet::new();
    let mut owners = BTreeSet::new();
    for claim in &input.claims {
        validate_claim(claim)?;
        if !ids.insert(&claim.claim_id) || !owners.insert((&claim.owner_id, claim.generation)) {
            return Err(invalid("Duplicate claim or owner generation."));
        }
    }
    let mut observations = BTreeSet::new();
    for o in &input.observations {
        if o.owner_id.trim().is_empty() || o.snapshot_id.trim().is_empty() {
            return Err(invalid("Observation identity is required."));
        }
        safe(o.generation)?;
        if !observations.insert((&o.snapshot_id, &o.owner_id, o.generation)) {
            return Err(invalid("Duplicate observation."));
        }
        for v in [o.ram_bytes, o.pinned_ram_bytes].into_iter().flatten() {
            safe(v)?;
        }
        if matches!((o.ram_bytes, o.pinned_ram_bytes), (Some(ram), Some(pinned)) if pinned > ram) {
            return Err(invalid("Observed pinned RAM exceeds RAM."));
        }
        validate_map(&o.gpu_bytes)?;
    }
    Ok(())
}
fn account_pool(
    input: &AccountingInput,
    id: &str,
    pool: &PoolBudget,
) -> Result<AccountedPool, PlannerError> {
    let mut reasons = Vec::new();
    let used = usage(pool);
    let current: Vec<_> = input
        .observations
        .iter()
        .filter(|o| o.snapshot_id == input.hardware.snapshot_id)
        .collect();
    let attributed = sum(current
        .iter()
        .map(|o| observation_value(o, id).unwrap_or(0)))?;
    if used.is_some_and(|used| attributed > used) {
        return Err(invalid(&format!(
            "Attributed usage exceeds global usage in {id}."
        )));
    }
    let mut residuals = Vec::new();
    for claim in &input.claims {
        let observed = current
            .iter()
            .find(|o| o.owner_id == claim.owner_id && o.generation == claim.generation)
            .and_then(|o| used.and_then(|_| observation_value(o, id)));
        let amount = claim_value(claim, id);
        if amount > 0 && observed.is_none() && reasons.is_empty() {
            reasons.push(
                "Unattributed reservation is counted in full; telemetry overlap is unknown.".into(),
            );
        }
        residuals.push(amount.saturating_sub(observed.unwrap_or(0)));
    }
    let residual_reserved_bytes = sum(residuals)?;
    let mut free_values = Vec::new();
    if let Some(free) = pool.free_bytes {
        free_values.push(free);
    }
    if let (Some(total), Some(used)) = (pool.total_bytes, pool.observed_used_bytes) {
        free_values.push(total - used);
    }
    let mut base_free_bytes = free_values.into_iter().min();
    if let Some(limit) = pool.limit_bytes {
        match used {
            None => {
                base_free_bytes = None;
                reasons.push("Global usage is required to apply the shared allocation cap.".into());
            }
            Some(used) => {
                base_free_bytes = base_free_bytes.map(|free| free.min(limit.saturating_sub(used)))
            }
        }
    }
    let mut available_bytes = base_free_bytes.map(|free| {
        free.saturating_sub(residual_reserved_bytes)
            .saturating_sub(pool.spare_bytes)
    });
    if base_free_bytes.is_none() {
        reasons.push("Free memory is unknown; total capacity alone is not availability.".into());
    }
    if input.hardware.snapshot_age_ms > input.hardware.max_snapshot_age_ms {
        available_bytes = None;
        reasons.push("Hardware snapshot is stale.".into());
    }
    Ok(AccountedPool {
        base_free_bytes,
        available_bytes,
        residual_reserved_bytes,
        spare_bytes: pool.spare_bytes,
        reasons,
    })
}
pub fn account_resources(input: &AccountingInput) -> Result<ResourceAvailability, PlannerError> {
    validate_accounting(input)?;
    Ok(ResourceAvailability {
        ram: account_pool(input, "ram", &input.hardware.ram)?,
        pinned_ram: input
            .hardware
            .pinned_ram
            .as_ref()
            .map(|p| account_pool(input, "pinnedRam", p))
            .transpose()?,
        gpus: input
            .hardware
            .gpus
            .iter()
            .map(|(id, pool)| Ok((id.clone(), account_pool(input, id, pool)?)))
            .collect::<Result<_, PlannerError>>()?,
    })
}
fn validate_range(r: &ByteRange) -> Result<(), PlannerError> {
    safe(r.min)?;
    if let Some(max) = r.max {
        safe(max)?;
        if max < r.min {
            return Err(invalid("Range maximum is below minimum."));
        }
    }
    Ok(())
}
fn validate_request(r: &ResourceRequest) -> Result<(), PlannerError> {
    if !["llama_cpp", "strata"].contains(&r.engine.as_str()) {
        return Err(invalid("Unknown engine."));
    }
    if !["dense", "moe", "unknown"].contains(&r.model.architecture.as_str())
        || !["standard", "other", "unknown"].contains(&r.model.attention.as_str())
    {
        return Err(invalid("Unknown model metadata kind."));
    }
    positive(r.context_tokens)?;
    if !["gguf", "other", "unknown"].contains(&r.model.format.as_str()) {
        return Err(invalid("Invalid model artifact metadata."));
    }
    positive(r.minimum_context_tokens)?;
    if r.minimum_context_tokens > r.context_tokens {
        return Err(invalid("Minimum context exceeds configured context."));
    }
    if let Some(bytes) = r.model.artifact_bytes {
        safe(bytes)?;
    }
    let o = &r.options;
    if !["allGpu", "hybrid", "cpu", "engineManaged"].contains(&o.placement.as_str()) {
        return Err(invalid("Unknown placement."));
    }
    if r.engine != "llama_cpp" && o.placement != "engineManaged" {
        return Err(invalid(
            "Only llama_cpp exposes generic placement variants.",
        ));
    }
    if ["allGpu", "hybrid"].contains(&o.placement.as_str())
        && o.gpu_id.as_ref().is_none_or(|id| id.trim().is_empty())
    {
        return Err(invalid("Explicit GPU ID is required for this placement."));
    }
    if o.gpu_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty() || ["ram", "pinnedRam"].contains(&id.as_str()))
    {
        return Err(invalid("Reserved/empty GPU ID."));
    }
    if o.placement == "cpu" && o.kv_on_gpu {
        return Err(invalid("CPU placement cannot offload KV to GPU."));
    }
    if let Some(layers) = o.gpu_layers {
        safe(layers)?;
    }
    if o.placement == "hybrid" && o.gpu_layers.is_none() {
        return Err(invalid("Hybrid placement requires gpuLayers."));
    }
    if let Some(capacity) = o.kv_capacity_tokens {
        positive(capacity)?;
        if capacity < r.context_tokens {
            return Err(invalid("KV capacity is below configured context."));
        }
    }
    for v in [o.extra_ram_bytes, o.pinned_ram_bytes, o.spare_ram_bytes] {
        safe(v)?;
    }
    for map in [&o.extra_gpu_bytes, &o.gpu_budget_bytes, &o.spare_gpu_bytes] {
        validate_map(map)?;
    }
    for range in [&o.workspace_ram, &o.workspace_gpu].into_iter().flatten() {
        validate_range(range)?;
    }
    if let Some(k) = &r.model.kv {
        for v in [k.layers, k.kv_heads, k.key_head_dim, k.value_head_dim] {
            positive(v)?;
        }
        for v in [k.key_bytes_per_element, k.value_bytes_per_element] {
            if !v.is_finite() || v <= 0.0 || v > 8.0 {
                return Err(invalid("Invalid KV bytes per element."));
            }
        }
        if o.gpu_layers.is_some_and(|layers| layers > k.layers) {
            return Err(invalid("gpuLayers exceeds known layer count."));
        }
    }
    Ok(())
}
fn range(min: f64, max: Option<f64>) -> Result<ByteRange, PlannerError> {
    if !min.is_finite()
        || min < 0.0
        || min.ceil() > MAX_SAFE as f64
        || max.is_some_and(|v| !v.is_finite() || v < 0.0 || v.ceil() > MAX_SAFE as f64)
    {
        return Err(invalid("Estimate exceeds the supported byte range."));
    }
    let result = ByteRange {
        min: min.ceil() as u64,
        max: max.map(|v| v.ceil() as u64),
    };
    validate_range(&result)?;
    Ok(result)
}
fn exact(bytes: u64) -> ByteRange {
    ByteRange {
        min: bytes,
        max: Some(bytes),
    }
}
fn add(a: &ByteRange, b: &ByteRange) -> Result<ByteRange, PlannerError> {
    Ok(ByteRange {
        min: sum([a.min, b.min])?,
        max: a.max.zip(b.max).map(|(a, b)| sum([a, b])).transpose()?,
    })
}
fn known_dense(r: &ResourceRequest) -> bool {
    r.engine == "llama_cpp"
        && r.model.architecture == "dense"
        && r.model.attention == "standard"
        && r.model.format == "gguf"
        && r.model.weights_complete
        && !r.options.unmodelled_allocations
        && r.model.artifact_bytes.is_some_and(|w| w > 0)
        && r.model.kv.is_some()
        && r.options.kv_capacity_tokens.is_some()
        && r.options.placement != "engineManaged"
}
fn estimate(r: &ResourceRequest) -> Result<ResourceEstimate, PlannerError> {
    let o = &r.options;
    let pinned = o.pinned_ram_bytes;
    let ram_floor = sum([pinned, o.extra_ram_bytes])?;
    let mut gpus: BTreeMap<_, _> = o
        .extra_gpu_bytes
        .iter()
        .map(|(id, value)| (id.clone(), exact(*value)))
        .collect();
    if !known_dense(r) {
        for value in gpus.values_mut() {
            value.max = None;
        }
        if let Some(id) = &o.gpu_id {
            let min = gpus.get(id).map_or(0, |v| v.min);
            gpus.insert(id.clone(), ByteRange { min, max: None });
        }
        let mut reasons = vec!["No validated full allocation model: engine, architecture, attention, artifact bytes, placement or KV capacity/metadata is incomplete.".into()];
        if r.engine != "llama_cpp" {
            reasons.push(format!(
                "{} has no calibrated allocation strategy in planner v1.",
                r.engine
            ));
        }
        if r.model.architecture != "dense" {
            reasons.push("Expert residency/paging and unknown architectures are not inferred from total artifact bytes.".into());
        }
        if r.model.attention != "standard" {
            reasons.push(
                "SWA, MLA, recurrent and mixed attention cannot use the uniform full KV formula."
                    .into(),
            );
        }
        if !r.model.weights_complete || r.model.format != "gguf" || o.unmodelled_allocations {
            reasons.push("Incomplete/non-GGUF weights or unmodelled dependencies invalidate the dense allocation envelope.".into());
        }
        reasons.push(
            "Disk artifact bytes are not a resident-memory bound for MoE/streaming engines.".into(),
        );
        reasons.push("Only explicit disjoint allocation floors are counted; unreported workspace, caches and loading peaks remain unknown.".into());
        return Ok(ResourceEstimate {
            artifact_bytes: r.model.artifact_bytes,
            kv: None,
            ram: ByteRange {
                min: ram_floor,
                max: None,
            },
            pinned_ram: ByteRange {
                min: pinned,
                max: None,
            },
            gpus,
            confidence: "unknown".into(),
            source: "knownFloorsOnly".into(),
            reasons,
        });
    }
    let k = r.model.kv.as_ref().unwrap();
    let w = r.model.artifact_bytes.unwrap() as f64;
    let nominal_kv = k.layers as f64
        * k.kv_heads as f64
        * (k.key_head_dim as f64 * k.key_bytes_per_element
            + k.value_head_dim as f64 * k.value_bytes_per_element)
        * o.kv_capacity_tokens.unwrap() as f64;
    let kv = range(nominal_kv, Some(nominal_kv * 1.10 + 16.0 * MIB))?;
    let fraction = match o.placement.as_str() {
        "allGpu" => 1.0,
        "cpu" => 0.0,
        _ => o.gpu_layers.unwrap() as f64 / k.layers as f64,
    };
    let lo = if o.placement == "hybrid" {
        (fraction - 0.15).max(0.0)
    } else {
        fraction
    };
    let hi = if o.placement == "hybrid" {
        (fraction + 0.15).min(1.0)
    } else {
        fraction
    };
    let workspace_ram = o
        .workspace_ram
        .clone()
        .unwrap_or(range(256.0 * MIB, Some(1024.0 * MIB))?);
    let mut ram = add(
        &range(
            ram_floor as f64 + 0.95 * w * (1.0 - hi).max(0.0),
            Some(ram_floor as f64 + 1.25 * w),
        )?,
        &workspace_ram,
    )?;
    if !o.kv_on_gpu {
        ram = add(&ram, &kv)?;
    }
    let use_gpu = fraction > 0.0 || o.kv_on_gpu;
    if use_gpu {
        let id = o
            .gpu_id
            .as_ref()
            .ok_or_else(|| invalid("GPU KV allocation requires an explicit GPU ID."))?;
        let workspace_gpu = o
            .workspace_gpu
            .clone()
            .unwrap_or(range(256.0 * MIB, Some(2048.0 * MIB))?);
        let mut gpu = add(&range(0.95 * w * lo, Some(1.20 * w * hi))?, &workspace_gpu)?;
        if o.kv_on_gpu {
            gpu = add(&gpu, &kv)?;
        }
        gpu = add(gpus.get(id).unwrap_or(&exact(0)), &gpu)?;
        gpus.insert(id.clone(), gpu);
    }
    let calibrated = o.workspace_ram.as_ref().is_some_and(|v| v.max.is_some())
        && (!use_gpu || o.workspace_gpu.as_ref().is_some_and(|v| v.max.is_some()));
    let mut reasons = vec![
        "Approximate standard dense MHA/GQA weights + KV allocation; ranges are engineering allowances, not certified upper bounds.".into(),
        "RAM upper estimate retains a full weight staging allowance even for GPU offload; mmap/page cache/copies vary by build.".into(),
        "KV capacity is the supplied total cache capacity; parallel slots are not multiplied again.".into(),
    ];
    if !calibrated {
        reasons.push("Missing workspace envelope uses uncalibrated RAM 256–1024 MiB and GPU 256–2048 MiB allowances.".into());
    }
    if o.placement == "hybrid" {
        reasons.push("Layer-based offload has ±15 percentage-point placement uncertainty for non-layer tensors.".into());
    }
    Ok(ResourceEstimate {
        artifact_bytes: r.model.artifact_bytes,
        kv: Some(kv),
        ram,
        pinned_ram: exact(pinned),
        gpus,
        confidence: if calibrated && o.placement != "hybrid" {
            "medium"
        } else {
            "low"
        }
        .into(),
        source: "llamaDenseApproximation".into(),
        reasons,
    })
}
fn assess(
    pool: String,
    required: ByteRange,
    accounted: Option<&AccountedPool>,
    spare: u64,
    cap: Option<u64>,
) -> PoolAssessment {
    let available = accounted
        .and_then(|a| {
            a.available_bytes
                .map(|v| v.saturating_sub(spare.saturating_sub(a.spare_bytes)))
        })
        .map(|v| cap.map_or(v, |cap| v.min(cap)));
    let status = if required.min == 0 && required.max == Some(0) {
        "withinEstimate"
    } else if available.is_some_and(|v| required.min > v) || cap.is_some_and(|v| required.min > v) {
        "insufficient"
    } else if available.is_none() || required.max.is_none() {
        "unknown"
    } else if required.max.unwrap() <= available.unwrap() {
        "withinEstimate"
    } else {
        "advisory"
    };
    PoolAssessment {
        pool,
        required,
        available_bytes: available,
        status: status.into(),
    }
}
fn candidate(
    id: &str,
    r: &ResourceRequest,
    a: &ResourceAvailability,
) -> Result<ResourceCandidate, PlannerError> {
    let e = estimate(r)?;
    let o = &r.options;
    let mut assessments = vec![
        assess(
            "ram".into(),
            e.ram.clone(),
            Some(&a.ram),
            o.spare_ram_bytes,
            None,
        ),
        assess(
            "pinnedRam".into(),
            e.pinned_ram.clone(),
            a.pinned_ram.as_ref(),
            0,
            None,
        ),
    ];
    for (id, range) in &e.gpus {
        assessments.push(assess(
            format!("gpu:{id}"),
            range.clone(),
            a.gpus.get(id),
            o.spare_gpu_bytes.get(id).copied().unwrap_or(0),
            o.gpu_budget_bytes.get(id).copied(),
        ));
    }
    let status = ["insufficient", "unknown", "advisory", "withinEstimate"]
        .into_iter()
        .find(|s| assessments.iter().any(|a| a.status == *s))
        .unwrap()
        .into();
    Ok(ResourceCandidate {
        id: id.into(),
        placement: o.placement.clone(),
        gpu_layers: o.gpu_layers,
        context_tokens: r.context_tokens,
        kv_capacity_tokens: o.kv_capacity_tokens,
        estimate: e,
        status,
        assessments,
    })
}
pub fn plan_resources(input: &ResourcePlannerInput) -> Result<ResourcePlan, PlannerError> {
    validate_request(&input.request)?;
    let accounting = AccountingInput {
        hardware: input.hardware.clone(),
        claims: input.claims.clone(),
        observations: input.observations.clone(),
    };
    let availability = account_resources(&accounting)?;
    let r = &input.request;
    let mut candidates = vec![candidate("configured", r, &availability)?];
    if known_dense(r) {
        let gpu_present = r
            .options
            .gpu_id
            .as_ref()
            .is_some_and(|id| input.hardware.gpus.contains_key(id));
        if gpu_present {
            if r.options.placement != "allGpu" {
                let mut variant = r.clone();
                variant.options.placement = "allGpu".into();
                variant.options.gpu_layers = None;
                candidates.push(candidate("allGpu", &variant, &availability)?);
            }
            if r.model.kv.as_ref().unwrap().layers > 1 && r.options.placement != "hybrid" {
                let mut variant = r.clone();
                variant.options.placement = "hybrid".into();
                variant.options.gpu_layers = Some(r.model.kv.as_ref().unwrap().layers / 2);
                candidates.push(candidate("hybrid", &variant, &availability)?);
            }
        }
        if r.options.placement != "cpu" {
            let mut variant = r.clone();
            variant.options.placement = "cpu".into();
            variant.options.gpu_layers = Some(0);
            variant.options.kv_on_gpu = false;
            candidates.push(candidate("cpu", &variant, &availability)?);
        }
        if r.options.kv_capacity_scales_with_context && r.context_tokens > r.minimum_context_tokens
        {
            let mut variant = r.clone();
            variant.context_tokens = r.minimum_context_tokens.max(r.context_tokens / 2);
            let capacity = (r.options.kv_capacity_tokens.unwrap() as f64
                * variant.context_tokens as f64
                / r.context_tokens as f64)
                .ceil();
            variant.options.kv_capacity_tokens = Some(range(capacity, Some(capacity))?.min);
            candidates.push(candidate("reducedContext", &variant, &availability)?);
        }
    }
    Ok(ResourcePlan {
        contract_version: 1,
        availability,
        candidates,
        automatic_application: false,
    })
}

dto!(LeaseSnapshot { revision: u64, claims: Vec<ResourceClaim> });
dto!(LeaseReceipt {
    revision: u64,
    claim: ResourceClaim,
    idempotent: bool
});
#[derive(Default)]
struct LeaseState {
    revision: u64,
    claims: BTreeMap<String, ResourceClaim>,
    last_generations: BTreeMap<String, u64>,
}
/// One registry per application. Lock encloses accounting + claim insertion.
/// Callers must supply fresh global telemetry and truthful included observations.
#[derive(Default)]
pub struct ResourceLeaseRegistry {
    state: Mutex<LeaseState>,
}
impl ResourceLeaseRegistry {
    pub fn snapshot(&self) -> Result<LeaseSnapshot, PlannerError> {
        let state = self
            .state
            .lock()
            .map_err(|_| error("poisoned", "Lease registry lock is poisoned."))?;
        Ok(LeaseSnapshot {
            revision: state.revision,
            claims: state.claims.values().cloned().collect(),
        })
    }
    pub fn try_claim(
        &self,
        input: &AccountingInput,
        claim: ResourceClaim,
        expected_revision: Option<u64>,
    ) -> Result<LeaseReceipt, PlannerError> {
        validate_claim(&claim)?;
        validate_accounting(input)?;
        if let Some(revision) = expected_revision {
            safe(revision)?;
        }
        if claim.amounts.ram_bytes == 0 && claim.amounts.gpu_bytes.values().all(|v| *v == 0) {
            return Err(invalid("An empty reservation cannot be claimed."));
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("poisoned", "Lease registry lock is poisoned."))?;
        if expected_revision.is_some_and(|v| v != state.revision) {
            return Err(error(
                "conflict",
                "Lease revision changed; recalculate admission.",
            ));
        }
        if let Some(existing) = state.claims.get(&claim.claim_id) {
            if existing == &claim {
                return Ok(LeaseReceipt {
                    revision: state.revision,
                    claim,
                    idempotent: true,
                });
            }
            return Err(error(
                "conflict",
                "Claim ID is already owned by a different reservation.",
            ));
        }
        if state.claims.values().any(|c| c.owner_id == claim.owner_id)
            || state
                .last_generations
                .get(&claim.owner_id)
                .is_some_and(|g| claim.generation <= *g)
        {
            return Err(error(
                "conflict",
                "Owner is already active or generation was reused.",
            ));
        }
        let mut merged: BTreeMap<String, ResourceClaim> = BTreeMap::new();
        for c in input.claims.iter().chain(state.claims.values()) {
            if c.claim_id == claim.claim_id {
                if c != &claim {
                    return Err(error(
                        "conflict",
                        "External claim differs from requested reservation.",
                    ));
                }
                continue;
            }
            if let Some(existing) = merged.get(&c.claim_id) {
                if existing != c {
                    return Err(error(
                        "conflict",
                        "External claim differs from registry claim.",
                    ));
                }
            } else {
                merged.insert(c.claim_id.clone(), c.clone());
            }
        }
        if merged.values().any(|c| c.owner_id == claim.owner_id) {
            return Err(error(
                "conflict",
                "External owner is already represented by a different claim.",
            ));
        }
        let mut accounting = input.clone();
        accounting.claims = merged.into_values().collect();
        let a = account_resources(&accounting)?;
        let mut required = vec![
            ("ram".to_string(), claim.amounts.ram_bytes, Some(&a.ram)),
            (
                "pinnedRam".to_string(),
                claim.amounts.pinned_ram_bytes,
                a.pinned_ram.as_ref(),
            ),
        ];
        for (id, amount) in &claim.amounts.gpu_bytes {
            required.push((format!("gpu:{id}"), *amount, a.gpus.get(id)));
        }
        let mut unknown_pools = Vec::new();
        for (id, amount, pool) in required {
            if amount == 0 {
                continue;
            }
            let budget = match id.as_str() {
                "ram" => Some(&input.hardware.ram),
                "pinnedRam" => input.hardware.pinned_ram.as_ref(),
                _ => input.hardware.gpus.get(id.trim_start_matches("gpu:")),
            };
            let observed = input
                .observations
                .iter()
                .find(|o| {
                    o.snapshot_id == input.hardware.snapshot_id
                        && o.owner_id == claim.owner_id
                        && o.generation == claim.generation
                })
                .and_then(|o| {
                    budget
                        .and_then(usage)
                        .and_then(|_| observation_value(o, id.strip_prefix("gpu:").unwrap_or(&id)))
                });
            let amount = amount.saturating_sub(observed.unwrap_or(0));
            let Some(free) = pool.and_then(|p| p.available_bytes) else {
                unknown_pools.push(id);
                continue;
            };
            if amount > free {
                return Err(error(
                    "insufficient",
                    &format!("Reservation exceeds availability in {id}."),
                ));
            }
        }
        if !unknown_pools.is_empty() {
            return Err(error(
                "unknown",
                &format!("Availability is unknown in {}.", unknown_pools.join(", ")),
            ));
        }
        state.revision = sum([state.revision, 1])?;
        state
            .last_generations
            .insert(claim.owner_id.clone(), claim.generation);
        state.claims.insert(claim.claim_id.clone(), claim.clone());
        Ok(LeaseReceipt {
            revision: state.revision,
            claim,
            idempotent: false,
        })
    }
    /// Generation-guarded, idempotent release; cannot delete a later incarnation.
    pub fn release(
        &self,
        claim_id: &str,
        owner_id: &str,
        generation: u64,
    ) -> Result<LeaseSnapshot, PlannerError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| error("poisoned", "Lease registry lock is poisoned."))?;
        if let Some(existing) = state.claims.get(claim_id) {
            if existing.owner_id != owner_id || existing.generation != generation {
                return Err(error(
                    "conflict",
                    "Release identity/generation does not match.",
                ));
            }
            state.revision = sum([state.revision, 1])?;
            state.claims.remove(claim_id);
        }
        Ok(LeaseSnapshot {
            revision: state.revision,
            claims: state.claims.values().cloned().collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    const GIB: u64 = 1_073_741_824;
    fn pool(total: u64) -> PoolBudget {
        PoolBudget {
            total_bytes: Some(total),
            observed_used_bytes: Some(0),
            free_bytes: None,
            limit_bytes: None,
            spare_bytes: 0,
        }
    }
    fn accounting(total: u64) -> AccountingInput {
        AccountingInput {
            hardware: HardwareBudget {
                snapshot_id: "sample-1".into(),
                snapshot_age_ms: 0,
                max_snapshot_age_ms: 1000,
                ram: pool(total),
                pinned_ram: None,
                gpus: BTreeMap::new(),
            },
            claims: vec![],
            observations: vec![],
        }
    }
    fn claim(id: &str, amount: u64, generation: u64) -> ResourceClaim {
        ResourceClaim {
            claim_id: id.into(),
            owner_id: id.into(),
            generation,
            amounts: ResourceAmounts {
                ram_bytes: amount,
                pinned_ram_bytes: 0,
                gpu_bytes: BTreeMap::new(),
            },
        }
    }
    fn fixture() -> ResourcePlannerInput {
        serde_json::from_value(serde_json::json!({
            "hardware": { "snapshotId":"sample-1", "snapshotAgeMs":0, "maxSnapshotAgeMs":1000,
                "ram":{"totalBytes":64*GIB,"observedUsedBytes":8*GIB,"spareBytes":4*GIB},
                "gpus":{"gpu0":{"totalBytes":16*GIB,"observedUsedBytes":2*GIB,"spareBytes":GIB}} },
            "claims":[],"observations":[], "request": {"engine":"llama_cpp","contextTokens":8192,"minimumContextTokens":6000,
                "model":{"artifactBytes":4*GIB,"format":"gguf","weightsComplete":true,"architecture":"dense","attention":"standard","kv":{"layers":32,"kvHeads":8,"keyHeadDim":128,"valueHeadDim":128,"keyBytesPerElement":2,"valueBytesPerElement":2}},
                "options":{"placement":"allGpu","gpuId":"gpu0","kvOnGpu":true,"kvCapacityTokens":8192,"kvCapacityScalesWithContext":true,"unmodelledAllocations":false,
                    "workspaceRam":{"min":268435456,"max":536870912},"workspaceGpu":{"min":268435456,"max":536870912},
                    "extraRamBytes":0,"pinnedRamBytes":0,"extraGpuBytes":{},"gpuBudgetBytes":{},"spareRamBytes":0,"spareGpuBytes":{}}
            }
        })).unwrap()
    }
    #[test]
    fn dense_formula_and_context_floor_are_explicit() {
        let result = plan_resources(&fixture()).unwrap();
        assert_eq!(result.contract_version, 1);
        assert!(!result.automatic_application);
        let c = &result.candidates[0];
        assert_eq!(c.estimate.kv.as_ref().unwrap().min, GIB);
        assert_eq!(c.estimate.ram.max, Some(5 * GIB + 536_870_912));
        assert_eq!(c.status, "withinEstimate");
        assert_eq!(c.estimate.confidence, "medium");
        let reduced = result
            .candidates
            .iter()
            .find(|c| c.id == "reducedContext")
            .unwrap();
        assert_eq!(reduced.context_tokens, 6000);
        assert_eq!(reduced.kv_capacity_tokens, Some(6000));
        // Serialize camelCase exactly as the TS contract, including unknown nulls.
        let json = serde_json::to_value(result).unwrap();
        assert_eq!(json["availability"]["ram"]["availableBytes"], 52 * GIB);
        assert_eq!(json["candidates"][0]["gpuLayers"], serde_json::Value::Null);
    }
    #[test]
    fn moe_and_other_engines_do_not_reuse_dense_formula() {
        let mut input = fixture();
        input.request.model.architecture = "moe".into();
        input.request.model.artifact_bytes = Some(512 * GIB);
        let result = plan_resources(&input).unwrap();
        assert_eq!(result.candidates.len(), 1);
        assert_eq!(result.candidates[0].status, "unknown");
        assert!(result.candidates[0].estimate.kv.is_none());
        for engine in ["strata"] {
            input.request.engine = engine.into();
            input.request.options.placement = "engineManaged".into();
            assert_eq!(
                plan_resources(&input).unwrap().candidates[0]
                    .estimate
                    .confidence,
                "unknown"
            );
        }
    }
    #[test]
    fn atomic_concurrent_claims_cannot_oversubscribe_same_snapshot() {
        let ledger = Arc::new(ResourceLeaseRegistry::default());
        let barrier = Arc::new(Barrier::new(16));
        let handles: Vec<_> = (0..16)
            .map(|n| {
                let ledger = ledger.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    ledger.try_claim(
                        &accounting(8 * GIB),
                        claim(&format!("run-{n}"), 4 * GIB, 1),
                        None,
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 2);
        assert!(results
            .iter()
            .filter_map(|r| r.as_ref().err())
            .all(|e| e.code == "insufficient"));
        assert_eq!(
            ledger
                .snapshot()
                .unwrap()
                .claims
                .iter()
                .map(|c| c.amounts.ram_bytes)
                .sum::<u64>(),
            8 * GIB
        );
    }
    #[test]
    fn concurrent_release_and_claim_are_serialized() {
        let ledger = Arc::new(ResourceLeaseRegistry::default());
        ledger
            .try_claim(&accounting(8 * GIB), claim("old", 6 * GIB, 1), None)
            .unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let l = ledger.clone();
        let b = barrier.clone();
        let release = std::thread::spawn(move || {
            b.wait();
            l.release("old", "old", 1).unwrap()
        });
        let l = ledger.clone();
        let b = barrier.clone();
        let reserve = std::thread::spawn(move || {
            b.wait();
            l.try_claim(&accounting(8 * GIB), claim("new", 6 * GIB, 1), None)
        });
        release.join().unwrap();
        let result = reserve.join().unwrap();
        if let Err(error) = result {
            assert_eq!(error.code, "insufficient");
            ledger
                .try_claim(&accounting(8 * GIB), claim("new", 6 * GIB, 1), None)
                .unwrap();
        }
        let snapshot = ledger.snapshot().unwrap();
        assert_eq!(snapshot.claims.len(), 1);
        assert_eq!(snapshot.claims[0].owner_id, "new");
    }
    #[test]
    fn late_release_cannot_remove_new_generation_and_reuse_is_rejected() {
        let ledger = ResourceLeaseRegistry::default();
        let input = accounting(8 * GIB);
        ledger
            .try_claim(&input, claim("run", GIB, 1), None)
            .unwrap();
        ledger.release("run", "run", 1).unwrap();
        assert_eq!(
            ledger
                .try_claim(&input, claim("run", GIB, 1), None)
                .unwrap_err()
                .code,
            "conflict"
        );
        ledger
            .try_claim(&input, claim("run", GIB, 2), None)
            .unwrap();
        assert_eq!(
            ledger.release("run", "run", 1).unwrap_err().code,
            "conflict"
        );
        assert_eq!(ledger.snapshot().unwrap().claims.len(), 1);
    }
    #[test]
    fn idempotence_conflict_and_revision_guards() {
        let ledger = ResourceLeaseRegistry::default();
        let input = accounting(8 * GIB);
        let first = ledger
            .try_claim(&input, claim("run", GIB, 1), Some(0))
            .unwrap();
        assert!(
            ledger
                .try_claim(&input, claim("run", GIB, 1), Some(first.revision))
                .unwrap()
                .idempotent
        );
        assert_eq!(
            ledger
                .try_claim(&input, claim("run", 2 * GIB, 1), None)
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(
            ledger
                .try_claim(&input, claim("next", GIB, 1), Some(0))
                .unwrap_err()
                .code,
            "conflict"
        );
        ledger.release("run", "run", 1).unwrap();
        let revision = ledger.snapshot().unwrap().revision;
        assert_eq!(ledger.release("run", "run", 1).unwrap().revision, revision);
    }
    #[test]
    fn attribution_offsets_only_included_usage_and_registry_echo_is_not_counted_twice() {
        let ledger = ResourceLeaseRegistry::default();
        let mut input = accounting(10 * GIB);
        ledger
            .try_claim(&input, claim("running", 6 * GIB, 1), None)
            .unwrap();
        input.hardware.ram.observed_used_bytes = Some(4 * GIB);
        input.claims = ledger.snapshot().unwrap().claims;
        input.observations.push(ResourceObservation {
            snapshot_id: "sample-1".into(),
            owner_id: "running".into(),
            generation: 1,
            ram_bytes: Some(4 * GIB),
            pinned_ram_bytes: None,
            gpu_bytes: BTreeMap::new(),
        });
        assert_eq!(
            account_resources(&input).unwrap().ram.available_bytes,
            Some(4 * GIB)
        );
        ledger
            .try_claim(&input, claim("next", 4 * GIB, 1), None)
            .unwrap();
        assert_eq!(ledger.snapshot().unwrap().claims.len(), 2);
    }
    #[test]
    fn adoption_of_an_observed_process_reserves_only_its_increment() {
        let ledger = ResourceLeaseRegistry::default();
        let mut input = accounting(8 * GIB);
        input.hardware.ram.observed_used_bytes = Some(6 * GIB);
        input.observations.push(ResourceObservation {
            snapshot_id: "sample-1".into(),
            owner_id: "running".into(),
            generation: 1,
            ram_bytes: Some(6 * GIB),
            pinned_ram_bytes: None,
            gpu_bytes: BTreeMap::new(),
        });
        input.claims.push(claim("running", 6 * GIB, 1));
        ledger
            .try_claim(&input, claim("running", 6 * GIB, 1), None)
            .unwrap();
        ledger
            .try_claim(&input, claim("next", 2 * GIB, 1), None)
            .unwrap();
    }
    #[test]
    fn pinned_ram_is_a_subset_and_missing_or_small_pinned_budget_blocks_admission() {
        let ledger = ResourceLeaseRegistry::default();
        let mut input = accounting(4 * GIB);
        let mut c = claim("run", 4 * GIB, 1);
        c.amounts.pinned_ram_bytes = 2 * GIB;
        assert_eq!(
            ledger.try_claim(&input, c.clone(), None).unwrap_err().code,
            "unknown"
        );
        input.hardware.pinned_ram = Some(pool(GIB));
        assert_eq!(
            ledger.try_claim(&input, c.clone(), None).unwrap_err().code,
            "insufficient"
        );
        input.hardware.pinned_ram = Some(pool(2 * GIB));
        ledger.try_claim(&input, c, None).unwrap();
    }
    #[test]
    fn stale_or_missing_telemetry_never_means_zero_load() {
        let ledger = ResourceLeaseRegistry::default();
        let mut input = accounting(8 * GIB);
        input.hardware.snapshot_age_ms = 1001;
        assert_eq!(
            ledger
                .try_claim(&input, claim("run", GIB, 1), None)
                .unwrap_err()
                .code,
            "unknown"
        );
        input.hardware.snapshot_age_ms = 0;
        input.hardware.ram.observed_used_bytes = None;
        assert_eq!(
            ledger
                .try_claim(&input, claim("run", GIB, 1), None)
                .unwrap_err()
                .code,
            "unknown"
        );
    }
    #[test]
    fn inconsistent_attribution_and_reserved_gpu_names_are_rejected() {
        let mut input = accounting(GIB);
        input.observations.push(ResourceObservation {
            snapshot_id: "sample-1".into(),
            owner_id: "x".into(),
            generation: 1,
            ram_bytes: Some(1),
            pinned_ram_bytes: None,
            gpu_bytes: BTreeMap::new(),
        });
        assert_eq!(account_resources(&input).unwrap_err().code, "invalidInput");
        input.observations.clear();
        let mut c = claim("run", 1, 1);
        c.amounts.gpu_bytes.insert("ram".into(), 1);
        input.claims.push(c);
        assert_eq!(account_resources(&input).unwrap_err().code, "invalidInput");
    }
}
