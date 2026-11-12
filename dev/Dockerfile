FROM archlinux:base

# Herramientas que el MCP necesita para probar sus parsers y su transporte SSH.
RUN pacman -Syu --noconfirm --needed \
      openssh procps-ng iproute2 util-linux lm_sensors pacman-contrib \
      cronie sudo which nano vim \
 && pacman -Scc --noconfirm \
 && ssh-keygen -A \
 && mkdir -p /root/.ssh \
 && chmod 700 /root/.ssh \
 && systemctl enable sshd \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
 && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && systemctl mask systemd-journald.service systemd-journald.socket \
      systemd-journald-dev-log.socket systemd-journald-audit.socket \
      systemd-journal-flush.service dbus-broker.service dbus.socket \
      systemd-homed.service systemd-firstboot.service \
      systemd-logind.service systemd-logind-varlink.socket

EXPOSE 22
CMD ["/usr/lib/systemd/systemd"]
