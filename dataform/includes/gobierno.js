// Personal data of the suppliers (REQ-014, DEC-008): the policy tag of the natural-person RUT and the salted supplier
// key. Self-contained: the compilation variables and the salt reference come in as arguments.

// Full name of a policy tag, as the Terraform output policy_tag_rut gives it.
const PATRON_POLICY_TAG = /^projects\/[^/]+\/locations\/[^/]+\/taxonomies\/[^/]+\/policyTags\/[^/]+$/;

/** The policy_tag_rut compilation variable; the compilation fails naming it when it is missing or malformed. */
function policyTagRut(vars) {
  const tag = vars?.policy_tag_rut;
  if (!tag || !PATRON_POLICY_TAG.test(tag)) {
    throw new Error(
      "falta la variable de compilación policy_tag_rut (nombre completo de la policy tag dato_personal.rut, output policy_tag_rut de Terraform)",
    );
  }
  return tag;
}

/**
 * Salted supplier key: SHA-256 in hex of the salt of `<sal_dataset>.sal` and the normalized RUT. The scalar subquery fails if the
 * table has more than one row; with none the key is NULL and the nonNull assertion fails.
 */
function proveedorKeySql(rut, sal) {
  return `TO_HEX(SHA256(CONCAT((SELECT sal FROM ${sal}), ${rut})))`;
}

module.exports = { PATRON_POLICY_TAG, policyTagRut, proveedorKeySql };
