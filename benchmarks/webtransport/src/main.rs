use anyhow::Result;
use wtransport::tls::Sha256DigestFmt;
use wtransport::{Endpoint, Identity, ServerConfig};

#[tokio::main]
async fn main() -> Result<()> {
    let identity = Identity::self_signed(["localhost", "127.0.0.1", "::1"])?;
    let digest = identity.certificate_chain().as_slice()[0]
        .hash()
        .fmt(Sha256DigestFmt::BytesArray);
    let config = ServerConfig::builder()
        .with_bind_default(0)
        .with_identity(identity)
        .build();
    let endpoint = Endpoint::server(config)?;
    println!("READY {} {}", endpoint.local_addr()?.port(), digest);

    loop {
        let incoming = endpoint.accept().await;
        tokio::spawn(async move {
            let result = async {
                let request = incoming.await?;
                let connection = request.accept().await?;
                loop {
                    let (mut send, mut receive) = connection.accept_bi().await?;
                    let mut buffer = [0_u8; 64 * 1024];
                    let mut received = 0_u64;
                    let mut valid = true;
                    while let Some(count) = receive.read(&mut buffer).await? {
                        received += count as u64;
                        valid &= buffer[..count].iter().all(|byte| *byte == 0xa5);
                    }
                    let response = if valid {
                        received.to_string()
                    } else {
                        "invalid".to_string()
                    };
                    send.write_all(response.as_bytes()).await?;
                    send.finish().await?;
                }
                #[allow(unreachable_code)]
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                eprintln!("connection error: {error:#}");
            }
        });
    }
}
