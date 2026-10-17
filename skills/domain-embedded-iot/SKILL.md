---
name: domain-embedded-iot
description: "Embedded firmware and IoT fleets domain pack (VTC spec 5.2a). Load when the repository or the specification shows microcontroller firmware or device fleets (PlatformIO, ESP-IDF, Zephyr, STM32 or nRF projects, MQTT, OTA update code); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Embedded firmware and IoT fleets domain pack

Load when: microcontroller firmware or device fleets (PlatformIO, ESP-IDF, Zephyr, STM32 or nRF
projects, MQTT, OTA update code).

## Rules

- **IOT-1** No dynamic allocation in real-time tasks after initialisation; static allocation or
  pools.
- **IOT-2** Check every return value of the SDK and HAL functions; fatal paths are explicit.
- **IOT-3** Interrupt handlers are minimal and defer work to tasks through queues or semaphores,
  using the interrupt-safe API variants; never block in an interrupt.
- **IOT-4** Stack sizes are measured (high-water marks), not guessed; shared state between tasks
  is synchronised.
- **IOT-5** Library and toolchain versions are pinned; never a floating latest.
- **IOT-6** Firmware updates are signed and verified on the device, applied to an A/B partition,
  and roll back automatically when the new image fails its health check.
- **IOT-7** Never update a whole fleet at once: canary on real hardware per revision, then phased
  rollout gated on health.
- **IOT-8** Each device has a unique, revocable identity; no shared fleet credential.
- **IOT-9** Intermittent connectivity is normal: buffer telemetry, make commands idempotent and
  expiring, reconcile on reconnect.
- **IOT-10** Protocols stay backward compatible with firmware already in the field.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-embedded-firmware-
engineer.md, engineering-iot-fleet-engineer.md.
