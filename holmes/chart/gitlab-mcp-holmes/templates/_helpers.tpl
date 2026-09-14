{{/*
Expand the name of the chart.
*/}}
{{- define "gitlab-mcp-holmes.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "gitlab-mcp-holmes.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "gitlab-mcp-holmes.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "gitlab-mcp-holmes.labels" -}}
helm.sh/chart: {{ include "gitlab-mcp-holmes.chart" . }}
{{ include "gitlab-mcp-holmes.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "gitlab-mcp-holmes.selectorLabels" -}}
app.kubernetes.io/name: {{ include "gitlab-mcp-holmes.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Container image reference: digest wins over tag.
*/}}
{{- define "gitlab-mcp-holmes.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{/*
Secret holding the GitLab token: chart-created or user-supplied.
*/}}
{{- define "gitlab-mcp-holmes.gitlabSecretName" -}}
{{- if .Values.gitlab.personalAccessToken }}
{{- printf "%s-gitlab-token" (include "gitlab-mcp-holmes.fullname" .) }}
{{- else }}
{{- required "gitlab.secretName (existing Secret with the GitLab token) or gitlab.personalAccessToken is required" .Values.gitlab.secretName }}
{{- end }}
{{- end }}

{{/*
Secret holding the MCP client token Holmes presents: chart-created or user-supplied.
*/}}
{{- define "gitlab-mcp-holmes.mcpAuthSecretName" -}}
{{- if .Values.mcp.authToken }}
{{- printf "%s-mcp-auth" (include "gitlab-mcp-holmes.fullname" .) }}
{{- else }}
{{- required "mcp.authSecretName (existing Secret with the client bearer token) or mcp.authToken is required: without it the server refuses to start with a server-side GitLab token" .Values.mcp.authSecretName }}
{{- end }}
{{- end }}

{{/*
In-cluster URL clients use; also the DNS-rebinding Host allowlist entry.
*/}}
{{- define "gitlab-mcp-holmes.serverUrl" -}}
{{- if .Values.mcp.serverUrl }}
{{- .Values.mcp.serverUrl }}
{{- else }}
{{- printf "http://%s.%s.svc.cluster.local:%v" (include "gitlab-mcp-holmes.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}
{{- end }}
