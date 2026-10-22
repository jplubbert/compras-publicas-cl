output "secret_ids" {
  description = "Ids of the secrets."
  value       = [for s in google_secret_manager_secret.this : s.secret_id]
}

output "secret_bindings" {
  description = "Secret grants: [{secret_id, role, member}]."
  value       = [for b in google_secret_manager_secret_iam_member.this : { secret_id = b.secret_id, role = b.role, member = b.member }]
}
