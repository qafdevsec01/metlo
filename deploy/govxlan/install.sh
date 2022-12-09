#!/bin/bash -e

echo "ADDING METLO USER"
sudo useradd -m metlo
sudo usermod -aG sudo metlo
echo "metlo:metlo" | sudo chpasswd
export WHOAMI=metlo

echo "GETTING FILES"
mkdir -p /home/$WHOAMI/metlo
sudo curl -L https://github.com/metlo-labs/metlo/releases/download/v0.0.2/metlo_0.0.2_linux_amd64.tar.gz > /home/$WHOAMI/metlo.tar.gz
sudo curl -L https://raw.githubusercontent.com/metlo-labs/metlo/master/deploy/govxlan/metlo-ingestor.service > /home/$WHOAMI/metlo/metlo-ingestor.service
sudo tar -xf /home/$WHOAMI/metlo.tar.gz -C /home/$WHOAMI/metlo
sudo cp /home/$WHOAMI/metlo/metlo-vxlan /usr/local/bin
sudo chmod +x /usr/local/bin/metlo-vxlan

echo "ADDING SERVICE"
echo "metlo" | sudo mv /home/$WHOAMI/metlo/metlo-ingestor.service /lib/systemd/system/metlo-ingestor.service -f

echo "STARTING SERVICES"
echo "metlo" | sudo systemctl daemon-reload
echo "metlo" | sudo systemctl enable metlo-ingestor.service
echo "metlo" | sudo systemctl start metlo-ingestor.service