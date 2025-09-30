// src/App.js
import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "bootstrap/dist/css/bootstrap.min.css";

/*
  Diagnostic Report Record — Builder (ABDM/FHIR document bundle)
  - Patient: fetched from /patients.json (public)
  - Practitioner: from window.GlobalPractitioner (FHIR Practitioner) or safe fallback
  - ABHA addresses normalized and selectable
  - DiagnosticReport + Observation(s)
  - Optional Encounter, Custodian, Attester
  - Optional DocumentReference + Binary (PDF/JPG/JPEG uploads; placeholder PDF if none)
  - Composition.type: LOINC 11502-2 "Laboratory report"
  - Bundle.type: "document"; internal references via urn:uuid:<uuid>
  - All narratives include lang & xml:lang (validator-friendly)
*/

/* ------------------------------- UTILITIES --------------------------------- */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function isUuid(s) {
  return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
}
function safeUuid(maybeId) {
  return isUuid((maybeId || "").toLowerCase()) ? maybeId.toLowerCase() : uuidv4();
}

/* Convert dd-mm-yyyy (or dd/mm/yyyy) to yyyy-mm-dd, else return undefined */
function ddmmyyyyToISO(v) {
  if (!v) return undefined;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return undefined;
  const parts = s.split(sep);
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/* ISO datetime with local timezone offset (e.g., 2025-08-30T15:04:05+05:30) */
function isoWithLocalOffsetFromDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const pad = n => String(Math.abs(Math.floor(n))).padStart(2, "0");
  const tzo = -date.getTimezoneOffset();
  const sign = tzo >= 0 ? "+" : "-";
  const hh = pad(Math.floor(Math.abs(tzo) / 60));
  const mm = pad(Math.abs(tzo) % 60);
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    "T" +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes()) +
    ":" +
    pad(date.getSeconds()) +
    sign +
    hh +
    ":" +
    mm
  );
}

/* Convert 'datetime-local' input (YYYY-MM-DDTHH:MM) to iso-with-offset */
function localDatetimeToISOWithOffset(localDatetime) {
  if (!localDatetime) return isoWithLocalOffsetFromDate(new Date());
  return isoWithLocalOffsetFromDate(new Date(localDatetime));
}

/* XHTML narrative wrapper with lang/xml:lang */
function buildNarrative(title, innerHtml) {
  return {
    status: "generated",
    div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${innerHtml}</div>`,
  };
}

/* Read file -> base64 (strip data: prefix) */
function fileToBase64NoPrefix(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("File read error"));
    reader.onload = () => {
      const res = reader.result || "";
      const idx = String(res).indexOf("base64,");
      if (idx >= 0) resolve(String(res).slice(idx + 7));
      else resolve(String(res));
    };
    reader.readAsDataURL(file);
  });
}

/* tiny placeholder PDF header */
const PLACEHOLDER_PDF_B64 = "JVBERi0xLjQKJeLjz9MK";

/* Fixed LOINC coding for Composition.type and section code (Laboratory report) */
const LOINC_LAB_REPORT = { system: "http://loinc.org", code: "11502-2", display: "Laboratory report" };

/* Normalize ABHA addresses (strings or objects) */
function normalizeAbhaAddresses(patientObj) {
  const raw =
    patientObj?.additional_attributes?.abha_addresses && Array.isArray(patientObj.additional_attributes.abha_addresses)
      ? patientObj.additional_attributes.abha_addresses
      : Array.isArray(patientObj?.abha_addresses)
        ? patientObj.abha_addresses
        : [];

  const out = raw
    .map(item => {
      if (!item) return null;
      if (typeof item === "string") return { value: item, label: item, primary: false };
      if (typeof item === "object") {
        if (item.address) return { value: String(item.address), label: item.isPrimary ? `${item.address} (primary)` : String(item.address), primary: !!item.isPrimary };
        try {
          const v = JSON.stringify(item);
          return { value: v, label: v, primary: !!item.isPrimary };
        } catch { return null; }
      }
      return null;
    })
    .filter(Boolean);
  out.sort((a, b) => (b.primary - a.primary) || a.value.localeCompare(b.value));
  return out;
}

/* Practitioner globals (from window) */
const gp = typeof window !== "undefined" ? window.GlobalPractitioner : null;
const practitionerRefId = safeUuid(gp?.id);
const practitionerDisplayName =
  (Array.isArray(gp?.name) && gp.name?.[0]?.text) ||
  (typeof gp?.name === "string" ? gp.name : "") ||
  "Dr. ABC";
const practitionerLicense =
  (Array.isArray(gp?.identifier) && gp.identifier?.[0]?.value) ||
  gp?.license ||
  "LIC-TEMP-0001";

/* ------------------------------- APP -------------------------------------- */
export default function App() {
  /* Patient selection */
  const [patients, setPatients] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);
  const selectedPatient = useMemo(() => (selectedPatientIdx >= 0 ? patients[selectedPatientIdx] : null), [patients, selectedPatientIdx]);

  /* ABHA selection */
  const [abhaOptions, setAbhaOptions] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");

  /* Composition meta */
  const [status, setStatus] = useState("final");
  const [title, setTitle] = useState("Diagnostic Report");
  const [dateTimeLocal, setDateTimeLocal] = useState(() => {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  /* Optional metadata */
  const [encounterText, setEncounterText] = useState("");
  const [custodianName, setCustodianName] = useState("");
  const [attesterMode, setAttesterMode] = useState("professional"); // personal | professional | legal | official
  const [attesterPartyType, setAttesterPartyType] = useState("Practitioner"); // Practitioner | Organization
  const [attesterOrgName, setAttesterOrgName] = useState("");

  /* Diagnostic data */
  const [testCode, setTestCode] = useState("CBC"); // mandatory-- remove CBC later
  const [observations, setObservations] = useState([
    { codeText: "", valueText: "", valueUnit: "", effectiveDate: "" },
  ]);

  function addObservation() {
    setObservations(prev => [...prev, { codeText: "", valueText: "", valueUnit: "", effectiveDate: "" }]);
  }
  function updateObservation(i, key, val) {
    setObservations(prev => prev.map((m, idx) => (idx === i ? { ...m, [key]: val } : m)));
  }
  function removeObservation(i) {
    setObservations(prev => prev.filter((_, idx) => idx !== i));
  }

  /* Document uploads (optional) */
  const fileInputRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [filePreviewNames, setFilePreviewNames] = useState([]);

  function onFilesPicked(e) {
    const list = e.target.files ? Array.from(e.target.files) : [];
    setFiles(list);
    setFilePreviewNames(list.map(f => f.name));
  }
  function removeFileAtIndex(i) {
    setFiles(prev => prev.filter((_, idx) => idx !== i));
    setFilePreviewNames(prev => prev.filter((_, idx) => idx !== i));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /* Load patients */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/patients.json");
        const data = await res.json();
        const arr = Array.isArray(data) ? data : [];
        setPatients(arr);
        if (arr.length > 0) {
          setSelectedPatientIdx(0);
          const abhas = normalizeAbhaAddresses(arr[0]);
          setAbhaOptions(abhas);
          setSelectedAbha(abhas.length ? abhas[0].value : "");
        }
      } catch (e) {
        console.error("Failed to load patients.json", e);
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedPatient) {
      setAbhaOptions([]);
      setSelectedAbha("");
      return;
    }
    const abhas = normalizeAbhaAddresses(selectedPatient);
    setAbhaOptions(abhas);
    setSelectedAbha(abhas.length ? abhas[0].value : "");
  }, [selectedPatientIdx]); // eslint-disable-line

  /* Validation */
  function validateBeforeBuild() {
    const errors = [];
    if (!selectedPatient) errors.push("Select a patient (required).");
    if (!status) errors.push("Status is required.");
    if (!title || !title.trim()) errors.push("Title is required.");
    if (!testCode || !testCode.trim()) errors.push("Test code is required.");
    // Require at least one observation (with a value) OR at least one document
    const hasObsWithValue = observations.some(o => (o.valueText && o.valueText.trim()) || (o.valueUnit && o.valueUnit.trim()));
    const hasDocs = files && files.length > 0;
    if (!(hasObsWithValue || hasDocs)) errors.push("Add at least one observation with a result value, or upload at least one document.");
    return errors;
  }

  /* ---------------------- Build FHIR Bundle (async) ------------------------ */
  async function onBuildBundle() {
    const errors = validateBeforeBuild();
    if (errors.length) {
      alert("Please fix:\n" + errors.join("\n"));
      return;
    }

    const authoredOn = localDatetimeToISOWithOffset(dateTimeLocal);

    // UUID ids for urn:uuid references
    const compId = uuidv4();
    const patientId = uuidv4(); // bundle-local Patient.id
    const practitionerId = practitionerRefId || uuidv4(); // use global if valid
    const encounterId = encounterText ? uuidv4() : null;
    const custodianId = custodianName ? uuidv4() : null;
    const attesterOrgId = attesterPartyType === "Organization" && attesterOrgName ? uuidv4() : null;

    const obsIds = observations.map(() => uuidv4());
    const diagReportId = uuidv4();
    const docBinaryIds = (files.length ? files : [null]).map(() => uuidv4());
    const docRefIds = docBinaryIds.map(() => uuidv4());

    // Patient resource
    function buildPatientResource(idForBundle) {
      const p = selectedPatient || {};
      const identifiers = [];
      const mrnLocal = p?.user_ref_id || p?.mrn || p?.abha_ref || p?.id;
      if (mrnLocal) identifiers.push({ system: "https://healthid.ndhm.gov.in", value: String(mrnLocal) });
      if (p?.abha_ref) identifiers.push({ system: "https://abdm.gov.in/abha", value: p.abha_ref });

      const telecom = [];
      if (p?.mobile) telecom.push({ system: "phone", value: p.mobile });
      if (p?.email) telecom.push({ system: "email", value: p.email });
      if (selectedAbha) telecom.push({ system: "url", value: `abha://${selectedAbha}` });

      return {
        resourceType: "Patient",
        id: idForBundle,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Patient"] },
        text: buildNarrative("Patient", `<p>${p.name || ""}</p><p>${p.gender || ""} ${p.dob || ""}</p>`),
        identifier: identifiers.length ? identifiers : undefined,
        name: p.name ? [{ text: p.name }] : undefined,
        gender: p.gender ? String(p.gender).toLowerCase() : undefined,
        birthDate: ddmmyyyyToISO(p.dob) || undefined,
        telecom: telecom.length ? telecom : undefined,
        address: p?.address ? [{ text: p.address }] : undefined,
      };
    }

    // Practitioner resource
    function buildPractitionerResource(practRefId, practName, practLicense) {
      return {
        resourceType: "Practitioner",
        id: practRefId,
        language: "en-IN",
        meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Practitioner"] },
        text: buildNarrative("Practitioner", `<p>${practName}</p>`),
        identifier: [{
          type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MD", display: "Medical License number" }] },
          system: "https://doctor.ndhm.gov.in",
          value: practLicense
        }],
        name: [{ text: practName }],
      };
    }

    // Encounter (optional)
    function buildEncounterResource() {
      if (!encounterId) return null;
      const start = isoWithLocalOffsetFromDate(new Date());
      return {
        resourceType: "Encounter",
        id: encounterId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Encounter"] },
        text: buildNarrative("Encounter", `<p>${encounterText}</p>`),
        status: "finished",
        class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "AMB", display: "ambulatory" },
        subject: { reference: `urn:uuid:${patientId}` },
        period: { start, end: start },
      };
    }

    // Custodian Organization (optional)
    function buildCustodianOrg() {
      if (!custodianId) return null;
      return {
        resourceType: "Organization",
        id: custodianId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        text: buildNarrative("Organization", `<p>${custodianName}</p>`),
        name: custodianName,
      };
    }

    // Attester org (optional)
    function buildAttesterOrg() {
      if (!attesterOrgId) return null;
      return {
        resourceType: "Organization",
        id: attesterOrgId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Organization"] },
        text: buildNarrative("Organization", `<p>${attesterOrgName}</p>`),
        name: attesterOrgName,
      };
    }

    // Observations
    function buildObservationResources() {
      return observations.map((m, idx) => {
        const id = obsIds[idx];
        const occ =
          m.effectiveDate
            ? (m.effectiveDate.includes("T")
              ? new Date(m.effectiveDate).toISOString()
              : ddmmyyyyToISO(m.effectiveDate) || new Date().toISOString())
            : authoredOn;

        const hasQuantity = m.valueUnit && m.valueUnit.trim() && !isNaN(Number(m.valueText));
        const valueQuantity = hasQuantity
          ? { value: Number(m.valueText), unit: m.valueUnit }
          : undefined;

        return {
          resourceType: "Observation",
          id,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Observation"] },
          text: buildNarrative("Observation", `<p>${m.codeText || testCode || "Test"}</p><p>${m.valueText || ""} ${m.valueUnit || ""}</p>`),
          status: "final",
          category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "laboratory", display: "Laboratory" }], text: "Laboratory" }],
          code: { text: m.codeText?.trim() ? m.codeText : (testCode || "Diagnostic test") },
          subject: { reference: `urn:uuid:${patientId}` },
          effectiveDateTime: occ,
          ...(valueQuantity ? { valueQuantity } : (m.valueText ? { valueString: m.valueText } : {})),
          performer: [{ reference: `urn:uuid:${practitionerId}`, display: practitionerDisplayName }],
        };
      });
    }

    // DiagnosticReport
    function buildDiagnosticReportResource(observationIds) {
      return {
        resourceType: "DiagnosticReport",
        id: diagReportId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DiagnosticReport"] },
        text: buildNarrative("DiagnosticReport", `<p>${title}</p><p>Code: ${testCode}</p>`),
        status: status,
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB", display: "Laboratory" }], text: "Laboratory" }],
        code: { coding: [LOINC_LAB_REPORT], text: title },
        subject: { reference: `urn:uuid:${patientId}` },
        effectiveDateTime: authoredOn,
        result: observationIds.map(id => ({ reference: `urn:uuid:${id}` })),
        performer: [{ reference: `urn:uuid:${practitionerId}`, display: practitionerDisplayName }],
      };
    }

    // DocumentReference + Binary (optional or placeholder)
    async function buildDocAndBinaryResources() {
      const binaries = [];
      const docRefs = [];

      const toProcess = files.length > 0 ? files : [null]; // null => placeholder
      for (let i = 0; i < toProcess.length; i++) {
        const f = toProcess[i];
        const binId = docBinaryIds[i];
        const docId = docRefIds[i];

        let contentType = "application/pdf";
        let dataB64 = PLACEHOLDER_PDF_B64;
        let title = "placeholder.pdf";

        if (f) {
          contentType = f.type || "application/pdf";
          dataB64 = await fileToBase64NoPrefix(f);
          title = f.name || title;
        }

        const binary = {
          resourceType: "Binary",
          id: binId,
          language: "en-IN",
          meta: { profile: ["https://nrces.in/ndhm/fhir/r4/StructureDefinition/Binary"] },
          contentType,
          data: dataB64,
        };

        const docRef = {
          resourceType: "DocumentReference",
          id: docId,
          language: "en-IN",
          meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"] },
          text: buildNarrative("DocumentReference", `<p>${title}</p>`),
          status: "current",
          type: { coding: [LOINC_LAB_REPORT], text: "Laboratory report document" },
          subject: { reference: `urn:uuid:${patientId}` },
          date: authoredOn,
          content: [{ attachment: { contentType, title, url: `urn:uuid:${binId}` } }],
        };

        binaries.push(binary);
        docRefs.push(docRef);
      }

      return { binaries, docRefs };
    }

    // Composition
    function buildComposition(docRefsArr) {
      const entries = [];

      // Include DiagnosticReport first
      entries.push({ reference: `urn:uuid:${diagReportId}`, type: "DiagnosticReport" });
      // Include Observations
      obsIds.forEach(id => entries.push({ reference: `urn:uuid:${id}`, type: "Observation" }));
      // Include uploaded documents
      if (docRefsArr && docRefsArr.length) docRefsArr.forEach(dr => entries.push({ reference: `urn:uuid:${dr.id}`, type: "DocumentReference" }));

      const attesterArr = [];
      if (attesterPartyType === "Practitioner") {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${practitionerId}` } });
      } else if (attesterPartyType === "Organization" && attesterOrgId) {
        attesterArr.push({ mode: attesterMode, party: { reference: `urn:uuid:${attesterOrgId}` } });
      }

      const comp = {
        resourceType: "Composition",
        id: compId,
        language: "en-IN",
        meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
        text: buildNarrative("Composition", `<p>${title}</p><p>Author: ${practitionerDisplayName}</p>`),
        status: status,
        type: { coding: [LOINC_LAB_REPORT], text: LOINC_LAB_REPORT.display },
        subject: { reference: `urn:uuid:${patientId}` },
        ...(encounterId ? { encounter: { reference: `urn:uuid:${encounterId}` } } : {}),
        date: authoredOn,
        author: [{ reference: `urn:uuid:${practitionerId}`, display: practitionerDisplayName }],
        title: title,
        attester: (attesterArr.length ? attesterArr : [{ mode: "official", party: { reference: `urn:uuid:${practitionerId}` } }]),
        ...(custodianId ? { custodian: { reference: `urn:uuid:${custodianId}` } } : {}),
        section: [
          {
            title: "Diagnostic report",
            code: { coding: [LOINC_LAB_REPORT], text: LOINC_LAB_REPORT.display },
            entry: entries.length ? entries : undefined,
            text: entries.length ? undefined : {
              status: "generated",
              div: `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><p>No diagnostic entries</p></div>`,
            },
          },
        ],
      };
      return comp;
    }

    // Build resources
    const patientRes = buildPatientResource(patientId);
    const practitionerRes = buildPractitionerResource(practitionerId, practitionerDisplayName, practitionerLicense);
    const encounterRes = buildEncounterResource();
    const custodianRes = buildCustodianOrg();
    const attesterOrgRes = buildAttesterOrg();
    const observationResources = buildObservationResources();
    const diagnosticReportRes = buildDiagnosticReportResource(obsIds);
    const { binaries, docRefs } = await buildDocAndBinaryResources();
    const compositionRes = buildComposition(docRefs);

    // Compose Bundle
    const bundleId = `DiagnosticReportBundle-${uuidv4()}`;
    const bundle = {
      resourceType: "Bundle",
      id: bundleId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Bundle"], lastUpdated: isoWithLocalOffsetFromDate(new Date()) },
      identifier: { system: "urn:ietf:rfc:3986", value: `urn:uuid:${uuidv4()}` },
      type: "document",
      timestamp: isoWithLocalOffsetFromDate(new Date()),
      entry: [
        { fullUrl: `urn:uuid:${compositionRes.id}`, resource: compositionRes },
        { fullUrl: `urn:uuid:${patientRes.id}`, resource: patientRes },
        { fullUrl: `urn:uuid:${practitionerRes.id}`, resource: practitionerRes },
        { fullUrl: `urn:uuid:${diagnosticReportRes.id}`, resource: diagnosticReportRes },
      ],
    };

    // Optional adds
    if (encounterRes) bundle.entry.push({ fullUrl: `urn:uuid:${encounterRes.id}`, resource: encounterRes });
    if (custodianRes) bundle.entry.push({ fullUrl: `urn:uuid:${custodianRes.id}`, resource: custodianRes });
    if (attesterOrgRes) bundle.entry.push({ fullUrl: `urn:uuid:${attesterOrgRes.id}`, resource: attesterOrgRes });

    // Observations
    observationResources.forEach(r => bundle.entry.push({ fullUrl: `urn:uuid:${r.id}`, resource: r }));

    // Documents
    docRefs.forEach(dr => bundle.entry.push({ fullUrl: `urn:uuid:${dr.id}`, resource: dr }));
    binaries.forEach(b => bundle.entry.push({ fullUrl: `urn:uuid:${b.id}`, resource: b }));

    // Submit
    const originalPatientId = String(selectedPatient?.id || "");
    axios.post("https://uat.discharge.org.in/api/v5/fhir-bundle", { bundle, patient: originalPatientId })
      .then(response => {
        console.log("FHIR Bundle Submitted:", response.data);
        alert("Submitted successfully");
      })
      .catch(error => {
        console.error("Error submitting FHIR Bundle:", error.response?.data || error.message);
        alert("Failed to submit FHIR Bundle. See console.");
        console.log("FHIR Bundle failed to submit:", { bundle, patient: originalPatientId });
      });
  }

  /* --------------------------------- UI ------------------------------------ */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Diagnostic Report — Builder</h2>

      {/* 1. Patient */}
      <div className="card mb-3">
        <div className="card-header">1. Patient <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient</label>
              <select className="form-select" value={selectedPatientIdx} onChange={e => setSelectedPatientIdx(Number(e.target.value))}>
                {patients.map((p, i) => <option key={p.id || i} value={i}>{p.name} {p.abha_ref ? `(${p.abha_ref})` : ""}</option>)}
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label">ABHA Address</label>
              <select className="form-select" value={selectedAbha} onChange={e => setSelectedAbha(e.target.value)} disabled={!abhaOptions.length}>
                {abhaOptions.length === 0 ? <option value="">No ABHA</option> : abhaOptions.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </div>
          </div>

          {selectedPatient && (
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label">Name</label>
                <input className="form-control" readOnly value={selectedPatient.name || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Gender</label>
                <input className="form-control" readOnly value={selectedPatient.gender || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">DOB</label>
                <input className="form-control" readOnly value={selectedPatient.dob || ""} />
              </div>
              <div className="col-md-2">
                <label className="form-label">Mobile</label>
                <input className="form-control" readOnly value={selectedPatient.mobile || ""} />
              </div>
              <div className="col-12">
                <label className="form-label">Address</label>
                <textarea className="form-control" rows={2} readOnly value={selectedPatient.address || ""} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 2. Practitioner (global) */}
      <div className="card mb-3">
        <div className="card-header">2. Practitioner (Author) <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Practitioner</label>
              <input className="form-control" readOnly value={practitionerDisplayName} />
            </div>
            <div className="col-md-6">
              <label className="form-label">License</label>
              <input className="form-control" readOnly value={practitionerLicense} />
            </div>
          </div>
        </div>
      </div>

      {/* 3. Composition metadata */}
      <div className="card mb-3">
        <div className="card-header">3. Composition Metadata</div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-3">
              <label className="form-label">Status</label>
              <select className="form-select" value={status} onChange={e => setStatus(e.target.value)}>
                <option value="preliminary">preliminary</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>
            <div className="col-md-6">
              <label className="form-label">Title</label>
              <input className="form-control" value={title} onChange={e => setTitle(e.target.value)} />
            </div>
            <div className="col-md-3">
              <label className="form-label">Date/Time</label>
              <input type="datetime-local" className="form-control" value={dateTimeLocal} onChange={e => setDateTimeLocal(e.target.value)} />
            </div>

            <div className="col-md-6">
              <label className="form-label">Encounter (optional)</label>
              <input className="form-control" value={encounterText} onChange={e => setEncounterText(e.target.value)} placeholder="Encounter reference text (optional)" />
            </div>
            <div className="col-md-6">
              <label className="form-label">Custodian Organization (optional)</label>
              <input className="form-control" value={custodianName} onChange={e => setCustodianName(e.target.value)} placeholder="Organization name (optional)" />
            </div>
          </div>
        </div>
      </div>

      {/* 4. Attester (optional) */}
      <div className="card mb-3">
        <div className="card-header">4. Attester (optional)</div>
        <div className="card-body">
          <div className="row g-3 align-items-end">
            <div className="col-md-3">
              <label className="form-label">Mode</label>
              <select className="form-select" value={attesterMode} onChange={e => setAttesterMode(e.target.value)}>
                <option value="personal">personal</option>
                <option value="professional">professional</option>
                <option value="legal">legal</option>
                <option value="official">official</option>
              </select>
            </div>

            <div className="col-md-3">
              <label className="form-label">Party type</label>
              <select className="form-select" value={attesterPartyType} onChange={e => setAttesterPartyType(e.target.value)}>
                <option value="Practitioner">Practitioner</option>
                <option value="Organization">Organization</option>
              </select>
            </div>

            {attesterPartyType === "Organization" && (
              <div className="col-md-6">
                <label className="form-label">Attester Organization name</label>
                <input className="form-control" value={attesterOrgName} onChange={e => setAttesterOrgName(e.target.value)} placeholder="Organization name (optional)" />
              </div>
            )}
            {attesterPartyType === "Practitioner" && (
              <div className="col-md-6">
                <label className="form-label">Attester Practitioner (read-only)</label>
                <input className="form-control" readOnly value={practitionerDisplayName} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. Test code (mandatory) */}
      <div className="card mb-3">
        <div className="card-header">5. Test Code <span className="text-danger">*</span></div>
        <div className="card-body">
          <div className="row g-3">
            <div className="col-md-6">
              <label className="form-label">Test Code (text or LOINC)</label>
              <input className="form-control" value={testCode} onChange={e => setTestCode(e.target.value)} placeholder="e.g., 'CBC', 'Glucose', or LOINC text" />
              <div className="form-text">This will be used as the default Observation.code.text if an observation’s code is blank.</div>
            </div>
          </div>
        </div>
      </div>

      {/* 6. Observations */}
      <div className="card mb-3">
        <div className="card-header">6. Observations (one or more)</div>
        <div className="card-body">
          {observations.map((m, i) => (
            <div key={i} className="border rounded p-2 mb-2">
              <div className="row g-2 align-items-end">
                <div className="col-md-4">
                  <label className="form-label">Code (optional)</label>
                  <input className="form-control" value={m.codeText} onChange={e => updateObservation(i, "codeText", e.target.value)} placeholder="Observation code text (if different from Test Code)" />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Value</label>
                  <input className="form-control" value={m.valueText} onChange={e => updateObservation(i, "valueText", e.target.value)} placeholder="Result value (e.g., 5.6 or 'Positive')" />
                </div>
                <div className="col-md-3">
                  <label className="form-label">Unit (optional)</label>
                  <input className="form-control" value={m.valueUnit} onChange={e => updateObservation(i, "valueUnit", e.target.value)} placeholder="e.g., mg/dL" />
                </div>
                <div className="col-md-2">
                  <label className="form-label">Date (optional)</label>
                  <input type="date" className="form-control" value={m.effectiveDate} onChange={e => updateObservation(i, "effectiveDate", e.target.value)} />
                </div>
              </div>
              <div className="mt-2 d-flex justify-content-end">
                <button className="btn btn-danger btn-sm" onClick={() => removeObservation(i)} disabled={observations.length === 1}>Remove</button>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addObservation}>+ Add Observation</button>
          <div className="form-text mt-2">Add at least one observation with a value or upload at least one document.</div>
        </div>
      </div>

      {/* 7. Documents (optional) */}
      <div className="card mb-3">
        <div className="card-header">7. Documents (optional) — DocumentReference + Binary</div>
        <div className="card-body">
          <div className="mb-2">
            <label className="form-label">Upload PDF / JPG / JPEG (multiple)</label>
            <input ref={fileInputRef} type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" multiple onChange={onFilesPicked} />
          </div>
          {filePreviewNames.length === 0 ? (
            <div className="text-muted">No files selected — a placeholder PDF will be embedded automatically.</div>
          ) : (
            <ul className="list-group">
              {filePreviewNames.map((n, i) => (
                <li className="list-group-item d-flex justify-content-between align-items-center" key={i}>
                  {n}
                  <button className="btn btn-sm btn-danger" onClick={() => removeFileAtIndex(i)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mb-4">
        <button className="btn btn-primary" onClick={onBuildBundle}>Submit</button>
      </div>
    </div>
  );
}