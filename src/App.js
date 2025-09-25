// src/DiagnosticReportForm.js
import React, { useState, useEffect, useRef } from "react";
import "bootstrap/dist/css/bootstrap.min.css";
import axios from "axios";

/* ---------- Helpers ---------- */

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* Global logged-in practitioner resolver:
   - Expects a FHIR Practitioner object on window.GlobalPractitionerFHIR or window.GlobalPractitioner
   - Flattens to { id, name, license } with safe fallbacks
*/
function resolveGlobalPractitioner() {
  const gp =
    (typeof window !== "undefined" &&
      (window.GlobalPractitionerFHIR || window.GlobalPractitioner)) ||
    null;

  const fallback = {
    id: `TEMP-${uuidv4()}`,
    name: "Dr. ABC",
    license: "LIC-TEMP-0001",
  };

  if (!gp) return fallback;

  // If it's already flattened shape like { id, name, license }
  if (typeof gp === "object" && gp.name && typeof gp.name === "string") {
    return {
      id: gp.id || fallback.id,
      name: gp.name || fallback.name,
      license: gp.license || fallback.license,
    };
  }

  // Assume FHIR Practitioner resource shape (like the one you shared)
  const id = gp.id || fallback.id;
  const name =
    (Array.isArray(gp.name) && gp.name[0] && gp.name[0].text) || fallback.name;
  const license =
    (Array.isArray(gp.identifier) &&
      gp.identifier[0] &&
      gp.identifier[0].value) ||
    fallback.license;

  return { id, name, license };
}

function getISOWithOffsetFromDateInput(dateInput) {
  const now = new Date();
  let d;
  if (dateInput) {
    // Accept YYYY-MM-DD already, or dd-mm-yyyy; we assume callers pass YYYY-MM-DD
    const maybe = dateInput;
    if (/^\d{4}-\d{2}-\d{2}$/.test(maybe)) {
      // it's already ISO date (yyyy-mm-dd)
      d = new Date(
        `${maybe}T${String(now.getHours()).padStart(2, "0")}:${String(
          now.getMinutes()
        ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`
      );
    } else {
      // fallback: attach current time and parse (caller should convert dd-mm-yyyy to ISO beforehand)
      d = new Date();
    }
  } else {
    d = now;
  }
  const tzOffsetMin = d.getTimezoneOffset();
  const sign = tzOffsetMin > 0 ? "-" : "+";
  const pad = (n) => String(n).padStart(2, "0");
  const offsetHr = pad(Math.floor(Math.abs(tzOffsetMin) / 60));
  const offsetMin = pad(Math.abs(tzOffsetMin) % 60);
  return d.toISOString().replace("Z", `${sign}${offsetHr}:${offsetMin}`);
}

/* Narrative wrapper with lang/xml:lang for validator */
function buildNarrative(title, html) {
  return `<div xmlns="http://www.w3.org/1999/xhtml" lang="en-IN" xml:lang="en-IN"><h3>${title}</h3>${html}</div>`;
}

/* Convert dd-mm-yyyy (or dd/mm/yyyy) to yyyy-mm-dd; if already ISO return it */
const ddmmyyyyToISO = (value) => {
  if (!value) return "";
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const sep = s.includes("-") ? "-" : s.includes("/") ? "/" : null;
  if (!sep) return s;
  const parts = s.split(sep);
  if (parts.length !== 3) return s;
  // detect whether dd-mm-yyyy or yyyy-mm-dd by length
  if (parts[0].length === 4) return s; // probably already yyyy-mm-dd
  const [d, m, y] = parts;
  if (y.length === 4) return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  return s;
};

const mapGender = (g) => {
  if (!g) return "";
  const s = String(g).toLowerCase();
  if (s.startsWith("m")) return "male";
  if (s.startsWith("f")) return "female";
  if (s.startsWith("o")) return "other";
  return "unknown";
};

/* Normalize ABHA addresses from your API shape (strings or objects with 'address' and 'isPrimary') */
const normalizeAbhaAddresses = (patientObj) => {
  const raw =
    patientObj?.additional_attributes?.abha_addresses &&
      Array.isArray(patientObj.additional_attributes.abha_addresses)
      ? patientObj.additional_attributes.abha_addresses
      : Array.isArray(patientObj?.abha_addresses)
        ? patientObj.abha_addresses
        : [];

  const out = raw
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        return { value: item, label: item, primary: false };
      }
      if (typeof item === "object") {
        if (item.address) {
          return {
            value: String(item.address),
            label: item.isPrimary ? `${item.address} (primary)` : String(item.address),
            primary: !!item.isPrimary,
          };
        }
        // If object shape unknown, stringify it
        try {
          const v = JSON.stringify(item);
          return { value: v, label: v, primary: !!item.isPrimary };
        } catch {
          return null;
        }
      }
      return null;
    })
    .filter(Boolean);

  // Sort primary first
  out.sort((a, b) => b.primary - a.primary || a.value.localeCompare(b.value));
  return out;
};

const pretty = (o) => JSON.stringify(o, null, 2);

/* ---------- Component ---------- */

export default function DiagnosticReportForm() {
  // Practitioner list + selection
  // const [practitionersList, setPractitionersList] = useState([]);
  // const [selectedPractitionerIdx, setSelectedPractitionerIdx] = useState(-1);
  const [practitioner, setPractitioner] = useState(resolveGlobalPractitioner());

  // Patients list + selection (from uploaded patients.json)
  const [patientsList, setPatientsList] = useState([]);
  const [selectedPatientIdx, setSelectedPatientIdx] = useState(-1);

  // Patient form state used in bundle: name, mrn, birthDate (YYYY-MM-DD), gender, phone
  const [patient, setPatient] = useState({
    id: "",
    name: "",
    mrn: "",
    birthDate: "",
    gender: "",
    phone: "",
  });

  // ABHA addresses for the selected patient
  const [abhaList, setAbhaList] = useState([]);
  const [selectedAbha, setSelectedAbha] = useState("");
  const [selectedAbhaNumber, setSelectedAbhaNumber] = useState("");

  // DiagnosticReport fields
  const [title, setTitle] = useState("Laboratory report");
  const [diagStatus, setDiagStatus] = useState("final"); // registered | partial | final | amended
  const [diagCategory, setDiagCategory] = useState("LAB"); // LAB or IMG
  const [diagCodeText, setDiagCodeText] = useState("");
  const [diagCodeSNOMED, setDiagCodeSNOMED] = useState("");
  const [issuedDate, setIssuedDate] = useState(new Date().toISOString().slice(0, 10));
  const [effectiveDate, setEffectiveDate] = useState("");
  const [encounterRef, setEncounterRef] = useState("");

  // Results/Specimens/Attachments
  const [results, setResults] = useState([
    { id: uuidv4(), codeText: "Hemoglobin", codeSnomed: "", value: "13.5 g/dL" },
  ]);
  const [specimens, setSpecimens] = useState([{ id: uuidv4(), typeText: "Blood sample" }]);
  const [attachments, setAttachments] = useState([]);
  const fileRef = useRef();

  // messages
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  /* ---------- Fetch patients: try API first, fallback to local ---------- */
  useEffect(() => {
    (async () => {
      try {
        // 🔹 First try API endpoint
        const apiRes = await fetch("/patients.json");
        if (!apiRes.ok) throw new Error("API fetch failed");
        const apiData = await apiRes.json();
        if (!Array.isArray(apiData) || apiData.length === 0) throw new Error("API returned empty");

        // If API worked, use it
        setPatientsList(apiData);
        setSelectedPatientIdx(0);
        const p = apiData[0];
        const derivedMrn = p.mrn || p.user_ref_id || p.abha_ref || String(p.user_id || "");
        const phone = p.mobile
          ? String(p.mobile).startsWith("+")
            ? String(p.mobile)
            : `+91${p.mobile}`
          : p.phone || "";
        setPatient({
          id: p.id,
          name: p.name || "",
          mrn: derivedMrn,
          birthDate: ddmmyyyyToISO(p.dob || p.birthDate || ""),
          gender: mapGender(p.gender),
          phone: phone,
        });
        const abhas = normalizeAbhaAddresses(p);
        setAbhaList(abhas);
        setSelectedAbha(abhas.length ? abhas[0].value : "");
        setSelectedAbhaNumber(p.abha_ref || "");
      } catch (apiErr) {
        console.warn("API fetch failed, falling back to local patients.json", apiErr);
        try {
          const localRes = await fetch("/patients.json");
          const localData = await localRes.json();
          const arr = Array.isArray(localData) ? localData : [];
          setPatientsList(arr);
          if (arr.length > 0) {
            setSelectedPatientIdx(0);
            const p = arr[0];
            const derivedMrn = p.mrn || p.user_ref_id || p.abha_ref || String(p.user_id || "");
            const phone = p.mobile
              ? String(p.mobile).startsWith("+")
                ? String(p.mobile)
                : `+91${p.mobile}`
              : p.phone || "";
            setPatient({
              id: p.id,
              name: p.name || "",
              mrn: derivedMrn,
              birthDate: ddmmyyyyToISO(p.dob || p.birthDate || ""),
              gender: mapGender(p.gender),
              phone: phone,
            });
            const abhas = normalizeAbhaAddresses(p);
            setAbhaList(abhas);
            setSelectedAbha(abhas.length ? abhas[0].value : "");
            setSelectedAbhaNumber(p.abha_ref || "");
          }
        } catch (localErr) {
          console.error("Failed to fetch local patients.json:", localErr);
        }
      }
    })();
  }, []);

  // Optional: re-resolve practitioner on mount in case the global FHIR object is attached after this script
  useEffect(() => {
    setPractitioner((prev) => {
      const resolved = resolveGlobalPractitioner();
      // Only update if something meaningful changed to avoid unnecessary re-renders
      if (
        !prev ||
        prev.id !== resolved.id ||
        prev.name !== resolved.name ||
        prev.license !== resolved.license
      ) {
        return resolved;
      }
      return prev;
    });
  }, []);

  /* ---------- Handlers ---------- */
  function handlePatientSelect(e) {
    const idx = Number(e.target.value);
    setSelectedPatientIdx(idx);
    const p = patientsList[idx];
    if (!p) {
      setAbhaList([]);
      setSelectedAbha("");
      setSelectedAbhaNumber("");
      return;
    }
    const derivedMrn = p.mrn || p.user_ref_id || p.abha_ref || String(p.user_id || "");
    const phone = p.mobile
      ? String(p.mobile).startsWith("+")
        ? String(p.mobile)
        : `+91${p.mobile}`
      : p.phone || "";
    setPatient({
      name: p.name || "",
      mrn: derivedMrn,
      birthDate: ddmmyyyyToISO(p.dob || p.birthDate || ""),
      gender: mapGender(p.gender),
      phone: phone,
    });
    const abhas = normalizeAbhaAddresses(p);
    setAbhaList(abhas);
    setSelectedAbha(abhas.length ? abhas[0].value : "");
    setSelectedAbhaNumber(p.abha_ref || "");
  }

  /* Results add/remove/update */
  function addResult() {
    setResults((prev) => [
      ...prev,
      { id: uuidv4(), codeText: "", codeSnomed: "", value: "" },
    ]);
  }
  function removeResult(i) {
    setResults((prev) => {
      if (prev.length <= 1) return prev;
      const copy = [...prev];
      copy.splice(i, 1);
      return copy;
    });
  }
  function updateResult(i, field, value) {
    setResults((prev) => {
      const copy = [...prev];
      copy[i][field] = value;
      return copy;
    });
  }

  /* Specimens add/remove/update */
  function addSpecimen() {
    setSpecimens((prev) => [...prev, { id: uuidv4(), typeText: "" }]);
  }
  function removeSpecimen(i) {
    setSpecimens((prev) => {
      if (prev.length <= 1) return prev;
      const copy = [...prev];
      copy.splice(i, 1);
      return copy;
    });
  }
  function updateSpecimen(i, field, value) {
    setSpecimens((prev) => {
      const copy = [...prev];
      copy[i][field] = value;
      return copy;
    });
  }

  /* Attachments */
  const handleAttachmentsChange = async (filesList) => {
    if (!filesList || filesList.length === 0) {
      setAttachments([]);
      return;
    }
    const files = Array.from(filesList);
    const readFile = (file) =>
      new Promise((resolve) => {
        if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64 = e.target.result.split(",")[1];
          resolve({ id: uuidv4(), name: file.name, mime: file.type, base64 });
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    const arr = await Promise.all(files.map(readFile));
    setAttachments(arr.filter(Boolean));
  };

  function removeAttachment(i) {
    setAttachments((prev) => {
      const copy = [...prev];
      copy.splice(i, 1);
      return copy;
    });
  }

  /* ---------- Build FHIR Bundle ---------- */
  function buildBundle() {
    setErrorMsg("");
    // Required checks
    if (!practitioner.name || !practitioner.license)
      throw new Error("Practitioner name and license required.");
    if (!patient.name || !patient.mrn || !patient.gender)
      throw new Error("Patient name, MRN and gender required.");
    if (!diagCodeText) throw new Error("Diagnostic test code/name is required.");
    if (!issuedDate) throw new Error("Issued date is required.");

    // generate ids
    const compId = uuidv4();
    const patientId = uuidv4();
    const practitionerId = uuidv4();
    const diagId = uuidv4();
    const obsIds = results.map(() => uuidv4());
    const specimenIds = specimens.map(() => uuidv4());
    const docIds = attachments.map(() => uuidv4());

    const bundle = {
      resourceType: "Bundle",
      id: `DiagnosticReportBundle-${uuidv4()}`,
      meta: {
        versionId: "1",
        lastUpdated: getISOWithOffsetFromDateInput(),
        profile: ["http://hl7.org/fhir/StructureDefinition/Bundle"],
      },
      identifier: {
        system: "https://ndhm.gov.in/fhir/bundles",
        value: `diagnostic-report-${uuidv4()}`,
      },
      type: "document",
      timestamp: getISOWithOffsetFromDateInput(),
      entry: [],
    };

    /* Composition */
    const compositionResource = {
      resourceType: "Composition",
      id: compId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Composition"] },
      language: "en-IN",
      text: {
        status: "generated",
        div: buildNarrative(
          "Laboratory report",
          `<p>${title}</p><p>Date: ${issuedDate}</p>`
        ),
      },
      status: "final",
      type: {
        coding: [
          { system: "http://loinc.org", code: "11502-2", display: "Laboratory report" },
        ],
        text: "Laboratory report",
      },
      subject: { reference: `urn:uuid:${patientId}`, display: patient.name },
      date: `${issuedDate}T00:00:00+05:30`,
      author: [{ reference: `urn:uuid:${practitionerId}`, display: practitioner.name }],
      title: title,
      section: [
        {
          title: "Laboratory report",
          code: {
            coding: [
              {
                system: "http://loinc.org",
                code: "11502-2",
                display: "Laboratory report",
              },
            ],
          },
          entry: [{ reference: `urn:uuid:${diagId}`, type: "DiagnosticReport" }],
        },
      ],
    };

    /* Patient resource */
    const patientResource = {
      resourceType: "Patient",
      id: patientId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Patient"] },
      text: {
        status: "generated",
        div: buildNarrative("Patient", `<p>${patient.name} (MRN: ${patient.mrn})</p>`),
      },
      identifier: [{ system: "https://healthid.ndhm.gov.in", value: patient.mrn }],
      name: [{ text: patient.name }],
      telecom: patient.phone
        ? [{ system: "phone", value: patient.phone, use: "home" }]
        : [],
      gender: patient.gender,
      birthDate: patient.birthDate || undefined,
    };

    /* Practitioner resource */
    const practitionerResource = {
      resourceType: "Practitioner",
      id: practitionerId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Practitioner"] },
      text: {
        status: "generated",
        div: buildNarrative("Practitioner", `<p>${practitioner.name}</p>`),
      },
      identifier: [{ system: "https://doctor.ndhm.gov.in", value: practitioner.license }],
      name: [{ text: practitioner.name }],
    };

    /* Observations */
    const observationResources = results.map((r, idx) => ({
      resourceType: "Observation",
      id: obsIds[idx],
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Observation"] },
      text: {
        status: "generated",
        div: buildNarrative("Result", `<p>${r.codeText}: ${r.value}</p>`),
      },
      status: "final",
      code:
        r.codeSnomed && r.codeSnomed.trim()
          ? {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: r.codeSnomed.trim(),
                display: r.codeText,
              },
            ],
            text: r.codeText,
          }
          : { text: r.codeText },
      subject: { reference: `urn:uuid:${patientId}`, display: patient.name },
      performer: [{ reference: `urn:uuid:${practitionerId}`, display: practitioner.name }],
      effectiveDateTime: effectiveDate
        ? getISOWithOffsetFromDateInput(effectiveDate)
        : getISOWithOffsetFromDateInput(issuedDate),
      valueString: r.value || undefined,
    }));

    /* Specimens */
    const specimenResources = specimens.map((s, idx) => ({
      resourceType: "Specimen",
      id: specimenIds[idx],
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/Specimen"] },
      text: {
        status: "generated",
        div: buildNarrative("Specimen", `<p>${s.typeText}</p>`),
      },
      subject: { reference: `urn:uuid:${patientId}`, display: patient.name },
      type: s.typeText ? { text: s.typeText } : undefined,
      receivedTime: getISOWithOffsetFromDateInput(issuedDate),
    }));

    /* DocumentReference (attachments) */
    const documentResources = attachments.map((att, idx) => {
      const id = docIds[idx];
      return {
        resourceType: "DocumentReference",
        id,
        meta: {
          profile: ["http://hl7.org/fhir/StructureDefinition/DocumentReference"],
        },
        text: { status: "generated", div: buildNarrative("Document", `<p>${att.name}</p>`) },
        status: "current",
        type: {
          coding: [
            { system: "http://loinc.org", code: "11502-2", display: "Laboratory report" },
          ],
          text: "Laboratory report",
        },
        subject: { reference: `urn:uuid:${patientId}`, display: patient.name },
        date: getISOWithOffsetFromDateInput(issuedDate),
        content: [
          { attachment: { contentType: att.mime, data: att.base64, title: att.name } },
        ],
      };
    });

    // Attach DocumentReference entries to Composition.section[0].entry if attachments present
    if (documentResources.length > 0) {
      const docEntries = documentResources.map((d) => ({
        reference: `urn:uuid:${d.id}`,
        type: "DocumentReference",
      }));
      compositionResource.section[0].entry.push(...docEntries);
    }

    /* DiagnosticReport */
    const diagCategoryCoding =
      diagCategory === "IMG"
        ? { system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "RAD", display: "Imaging" }
        : { system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB", display: "Laboratory" };

    const diagnosticReportResource = {
      resourceType: "DiagnosticReport",
      id: diagId,
      meta: { profile: ["http://hl7.org/fhir/StructureDefinition/DiagnosticReport"] },
      text: {
        status: "generated",
        div: buildNarrative("DiagnosticReport", `<p>${diagCodeText} (${diagCategory})</p>`),
      },
      status: diagStatus,
      category: [
        {
          coding: [diagCategoryCoding],
          text: diagCategoryCoding.display,
        },
      ],
      code:
        diagCodeSNOMED && String(diagCodeSNOMED).trim()
          ? {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: String(diagCodeSNOMED).trim(),
                display: diagCodeText,
              },
            ],
            text: diagCodeText,
          }
          : { text: diagCodeText },
      subject: { reference: `urn:uuid:${patientId}`, display: patient.name },
      performer: [{ reference: `urn:uuid:${practitionerId}`, display: practitioner.name }],
      issued: getISOWithOffsetFromDateInput(issuedDate),
      result: observationResources.map((o) => ({ reference: `urn:uuid:${o.id}` })),
      specimen: specimenResources.map((s) => ({ reference: `urn:uuid:${s.id}` })),
    };

    // Compose final bundle entries (order matters for forward traversal)
    bundle.entry.push({ fullUrl: `urn:uuid:${compId}`, resource: compositionResource });
    bundle.entry.push({ fullUrl: `urn:uuid:${patientId}`, resource: patientResource });
    bundle.entry.push({ fullUrl: `urn:uuid:${practitionerId}`, resource: practitionerResource });
    bundle.entry.push({ fullUrl: `urn:uuid:${diagId}`, resource: diagnosticReportResource });

    observationResources.forEach((r) =>
      bundle.entry.push({ fullUrl: `urn:uuid:${r.id}`, resource: r })
    );
    specimenResources.forEach((s) =>
      bundle.entry.push({ fullUrl: `urn:uuid:${s.id}`, resource: s })
    );
    documentResources.forEach((d) =>
      bundle.entry.push({ fullUrl: `urn:uuid:${d.id}`, resource: d })
    );

    return bundle;
  }

  /* Submit handler */
  const handleSubmit = async (e) => {
    e.preventDefault();
    const bundle = buildBundle();
    console.log("FHIR Bundle:", bundle);

    try {
      const resp = await axios.post("https://uat.discharge.org.in/api/v5/fhir-bundle", {
        bundle,
        patient: patient.id
      });
      console.log("FHIR Bundle submitted:", resp.data);
      console.log(JSON.stringify(bundle), {patient: patient.id})
      console.log("patient id", {patient: patient.id})
      alert("Submitted successfully");
    } catch (error) {
      console.error("Error submitting FHIR Bundle:", error?.response?.data || error.message);
      alert("Failed to submit FHIR Bundle. See console for details.");
      console.log(JSON.stringify(bundle), {patient: patient.id})
      console.log("patient id", {patient: patient.id})
    }
  };

  /* ---------- Render UI ---------- */
  return (
    <div className="container py-4">
      <h2 className="mb-3">Laboratory report (diagnostic) — Builder</h2>

      {/* Practitioner */}
      <div className="card mb-3">
        <div className="card-header">
          1. Practitioner (Author) <span className="text-danger">*</span>
        </div>
        <div className="card-body">
          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label">Practitioner Name *</label>
              <input
                className="form-control"
                value={practitioner.name}
                readOnly
              />
            </div>

            <div className="col-md-6">
              <label className="form-label">Name *</label>
              <input
                className="form-control"
                value={practitioner.name}
                readOnly
              />
            </div>

            <div className="col-md-6 mt-2">
              <label className="form-label">License No. *</label>
              <input
                className="form-control"
                value={practitioner.license}
                readOnly
              />
            </div>
          </div>
        </div>
      </div>

      {/* Patient */}
      <div className="card mb-3">
        <div className="card-header">
          2. Patient <span className="text-danger">*</span>
        </div>
        <div className="card-body">
          <div className="row g-2 mb-2">
            <div className="col-md-8">
              <label className="form-label">Select Patient (mock API)</label>
              <select
                className="form-select"
                value={selectedPatientIdx < 0 ? "" : String(selectedPatientIdx)}
                onChange={handlePatientSelect}
              >
                <option value="">-- Select patient --</option>
                {patientsList.map((p, i) => (
                  <option
                    key={(p.user_ref_id || p.email || p.mobile || i) + "_opt"}
                    value={i}
                  >
                    {p.name} — {p.mobile || p.email || p.mobile || "no mobile"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="row g-2">
            <div className="col-md-6">
              <label className="form-label">Full Name *</label>
              <input
                className="form-control"
                value={patient.name}
                readOnly
              />
            </div>

            <div className="col-md-6">
              <label className="form-label">MRN *</label>
              <input
                className="form-control"
                value={patient.mrn}
                readOnly
              />
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Phone</label>
              <input
                className="form-control"
                value={patient.phone}
                readOnly
              />
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Gender *</label>
              <select
                className="form-select"
                value={patient.gender}
                readOnly
              >
                <option value="">--Select--</option>
                <option value="male">Male</option>
                <option value="female">Female</option>
                <option value="other">Other</option>
                <option value="unknown">Unknown</option>
              </select>
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Birth Date</label>
              <input
                type="date"
                className="form-control"
                value={patient.birthDate}
                readOnly
              />
            </div>

            <div className="col-md-6 mt-2">
              <label className="form-label">ABHA Address</label>
              <select
                className="form-select"
                value={selectedAbha}
                onChange={(e) => setSelectedAbha(e.target.value)}
                disabled={abhaList.length === 0}
              >
                {abhaList.length === 0 ? (
                  <option value="">No ABHA addresses</option>
                ) : (
                  abhaList.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="col-md-6 mt-2">
              <label className="form-label">ABHA Number</label>
              <input className="form-control" value={selectedAbhaNumber} readOnly />
            </div>
          </div>
        </div>
      </div>

      {/* Report details, results, specimens, attachments (same layout as before) */}
      <div className="card mb-3">
        <div className="card-header bg-info text-white">3. Report Details</div>
        <div className="card-body">
          <div className="row g-2">
            <div className="col-md-4">
              <label className="form-label">Title *</label>
              <input
                className="form-control"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="col-md-4">
              <label className="form-label">Status *</label>
              <select
                className="form-select"
                value={diagStatus}
                onChange={(e) => setDiagStatus(e.target.value)}
              >
                <option value="registered">registered</option>
                <option value="partial">partial</option>
                <option value="final">final</option>
                <option value="amended">amended</option>
                <option value="entered-in-error">entered-in-error</option>
              </select>
            </div>

            <div className="col-md-4">
              <label className="form-label">Category *</label>
              <select
                className="form-select"
                value={diagCategory}
                onChange={(e) => setDiagCategory(e.target.value)}
              >
                <option value="LAB">Laboratory (LAB)</option>
                <option value="IMG">Imaging (IMG)</option>
              </select>
            </div>

            <div className="col-md-6 mt-2">
              <label className="form-label">Test Code / Name *</label>
              <input
                className="form-control"
                value={diagCodeText}
                onChange={(e) => setDiagCodeText(e.target.value)}
                placeholder="e.g., CBC, Chest X-Ray"
              />
            </div>

            <div className="col-md-6 mt-2">
              <label className="form-label">SNOMED Code (optional)</label>
              <input
                className="form-control"
                value={diagCodeSNOMED}
                onChange={(e) => setDiagCodeSNOMED(e.target.value)}
                placeholder="optional SNOMED code"
              />
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Issued Date *</label>
              <input
                type="date"
                className="form-control"
                value={issuedDate}
                onChange={(e) => setIssuedDate(e.target.value)}
              />
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Effective Date (optional)</label>
              <input
                type="date"
                className="form-control"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </div>

            <div className="col-md-4 mt-2">
              <label className="form-label">Encounter Ref (optional)</label>
              <input
                className="form-control"
                value={encounterRef}
                onChange={(e) => setEncounterRef(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="card mb-3">
        <div className="card-header">4. Results (Observations)</div>
        <div className="card-body">
          {results.map((r, i) => (
            <div className="row g-2 align-items-center mb-2" key={r.id}>
              <div className="col-md-4">
                <input
                  className="form-control"
                  placeholder="Result name"
                  value={r.codeText}
                  onChange={(e) => updateResult(i, "codeText", e.target.value)}
                />
              </div>
              <div className="col-md-3">
                <input
                  className="form-control"
                  placeholder="SNOMED code (opt)"
                  value={r.codeSnomed}
                  onChange={(e) => updateResult(i, "codeSnomed", e.target.value)}
                />
              </div>
              <div className="col-md-4">
                <input
                  className="form-control"
                  placeholder="Value"
                  value={r.value}
                  onChange={(e) => updateResult(i, "value", e.target.value)}
                />
              </div>
              <div className="col-md-1">
                <button
                  className="btn btn-danger w-100"
                  onClick={() => removeResult(i)}
                  disabled={results.length === 1}
                >
                  X
                </button>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addResult}>
            + Add result
          </button>
        </div>
      </div>

      {/* Specimens */}
      <div className="card mb-3">
        <div className="card-header">5. Specimens (optional)</div>
        <div className="card-body">
          {specimens.map((s, i) => (
            <div className="row g-2 align-items-center mb-2" key={s.id}>
              <div className="col-md-10">
                <input
                  className="form-control"
                  placeholder="Specimen type"
                  value={s.typeText}
                  onChange={(e) => updateSpecimen(i, "typeText", e.target.value)}
                />
              </div>
              <div className="col-md-2">
                <button
                  className="btn btn-danger w-100"
                  onClick={() => removeSpecimen(i)}
                  disabled={specimens.length === 1}
                >
                  X
                </button>
              </div>
            </div>
          ))}
          <button className="btn btn-sm btn-outline-secondary" onClick={addSpecimen}>
            + Add specimen
          </button>
        </div>
      </div>

      {/* Attachments */
      }
      <div className="card mb-3">
        <div className="card-header">6. Attachments (optional)</div>
        <div className="card-body">
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            ref={fileRef}
            className="form-control mb-2"
            multiple
            onChange={(e) => handleAttachmentsChange(e.target.files)}
          />
          {attachments.length === 0 ? (
            <div className="text-muted">No attachments</div>
          ) : (
            attachments.map((att, idx) => (
              <div key={att.id} className="d-flex align-items-center mb-1">
                <div className="flex-grow-1">
                  {att.name} ({att.mime})
                </div>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => removeAttachment(idx)}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {errorMsg && <div className="alert alert-danger">{errorMsg}</div>}
      {successMsg && <div className="alert alert-success">{successMsg}</div>}
      <div className="mb-5">
        <button className="btn btn-primary" onClick={handleSubmit}>
          Submit
        </button>
      </div>
    </div>
  );
}