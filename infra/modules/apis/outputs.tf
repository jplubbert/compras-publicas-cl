output "services" {
  description = "Enabled services."
  value       = [for s in google_project_service.this : s.service]
}
