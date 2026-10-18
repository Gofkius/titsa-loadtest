FROM grafana/k6
COPY script.js data.json /
CMD ["run", "/script.js"]
